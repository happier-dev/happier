//! Native lifecycle boundary for the Iroh Home transport.
//!
//! One process endpoint per identity (shared by repeated acceptor/tunnel
//! leases), the handle-based lifecycle from the Lane 06 plan
//! (create/reuse endpoint, start/stop Home acceptor, ensure/release Home
//! tunnel, status, explicit shutdown), and the legacy mobile JSON ops as thin
//! adapters over that single owner. Status/metadata only: no tunnel payload
//! byte ever crosses this boundary.

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use happier_iroh_core::{
    validate_endpoint_id, validate_loopback_target, EndpointConfig, EndpointIdentity,
    EndpointKeyStore, EndpointManager, EndpointSeed, HomeAcceptor, HomeAcceptorConfig, HomeTunnel,
    HomeTunnelConfig, IrohCapProfile, IrohEndpoint, MachineAcceptor, MachineAcceptorConfig,
    MachineHttpTunnel, MachineTunnel, MachineTunnelConfig, MachineTunnelStatus, NativeHttpLease, RelayPolicy,
    RelaySelection,
};
pub use happier_iroh_core::{IrohError, MachineHandshakeProvider};
use serde::Deserialize;
use serde_json::{json, Value};
#[cfg(feature = "test-relay-fixture")]
use std::any::Any;
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::net::{IpAddr, SocketAddr};
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Condvar, Mutex, OnceLock,
};
use tokio::runtime::{Builder, Runtime};
use tokio::sync::watch;
use zeroize::Zeroize;

fn default_relay_policy() -> String {
    "automatic".to_owned()
}

fn default_cap_profile() -> String {
    IrohCapProfile::HomeInteractive.id().to_owned()
}

fn default_target_host() -> String {
    "127.0.0.1".to_owned()
}

fn default_machine_cap_profile() -> String {
    IrohCapProfile::MachineBulk.id().to_owned()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateEndpointRequest {
    #[serde(default)]
    key_path: Option<String>,
    #[serde(default)]
    endpoint_seed_base64: Option<String>,
    #[serde(default = "default_relay_policy")]
    relay_policy: String,
    #[serde(default)]
    relay_urls: Vec<String>,
    #[serde(default = "default_cap_profile")]
    cap_profile: String,
}

#[cfg(feature = "test-relay-fixture")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForceRelayOnlyRequest {
    #[serde(default)]
    relay_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartHomeAcceptorRequest {
    endpoint_handle: String,
    #[serde(default = "default_target_host")]
    target_host: String,
    target_port: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EndpointHandleRequest {
    endpoint_handle: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnsureTunnelRequest {
    endpoint_handle: String,
    home_server_identity_id: String,
    endpoint_id: String,
    #[serde(default)]
    direct_addresses: Vec<SocketAddr>,
    #[serde(default)]
    relay_urls: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelHandleRequest {
    tunnel_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartMachineAcceptorRequest {
    endpoint_handle: String,
    #[serde(default = "default_target_host")]
    admission_host: String,
    admission_port: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartMachineTunnelRequest {
    endpoint_handle: String,
    endpoint_id: String,
    #[serde(default)]
    direct_addresses: Vec<SocketAddr>,
    #[serde(default)]
    relay_urls: Vec<String>,
    handshake_json: String,
    #[serde(default = "default_machine_cap_profile")]
    cap_profile: String,
    #[serde(default)]
    native_http_lease: Option<NativeHttpLeaseRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeHttpLeaseRequest { open_json: String }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MachineTunnelHandleRequest {
    machine_tunnel_id: String,
}

struct AcceptorEntry {
    acceptor: HomeAcceptor,
    target: SocketAddr,
}

struct TunnelLease {
    home_server_identity_id: String,
    endpoint_handle: String,
    tunnel: HomeTunnel,
    runtime_origin: String,
    started_at_ms: u64,
}

struct MachineAcceptorEntry {
    acceptor: MachineAcceptor,
    admission_target: SocketAddr,
}

struct MachineTunnelLease {
    endpoint_handle: String,
    tunnel: MachineTunnelKind,
    started_at_ms: u64,
}

struct EndpointHandleEntry {
    identity: EndpointIdentity,
    lifecycle: Arc<EndpointLifecycle>,
}

#[derive(Default)]
struct EndpointLifecycleState {
    shutting_down: bool,
    admitted: usize,
}

/// Per-endpoint admission and cancellation owned by the existing native
/// lifecycle boundary. This is deliberately not a general task registry:
/// every admitted operation remains on its calling host thread, while this
/// state only closes admission, signals cancellation, and lets shutdown wait
/// for custody to settle.
struct EndpointLifecycle {
    state: Mutex<EndpointLifecycleState>,
    settled: Condvar,
    cancellation: watch::Sender<bool>,
}

impl EndpointLifecycle {
    fn new() -> Self {
        let (cancellation, _) = watch::channel(false);
        Self {
            state: Mutex::new(EndpointLifecycleState::default()),
            settled: Condvar::new(),
            cancellation,
        }
    }

    fn try_admit(self: &Arc<Self>) -> Option<EndpointAdmission> {
        let mut state = self.state.lock().expect("endpoint lifecycle lock poisoned");
        if state.shutting_down {
            return None;
        }
        state.admitted += 1;
        Some(EndpointAdmission {
            lifecycle: Arc::clone(self),
            cancellation: self.cancellation.subscribe(),
        })
    }

    fn begin_shutdown(&self) {
        let mut state = self.state.lock().expect("endpoint lifecycle lock poisoned");
        if !state.shutting_down {
            state.shutting_down = true;
            let _ = self.cancellation.send(true);
        }
    }

    fn wait_for_admitted(&self) {
        let mut state = self.state.lock().expect("endpoint lifecycle lock poisoned");
        while state.admitted != 0 {
            state = self
                .settled
                .wait(state)
                .expect("endpoint lifecycle lock poisoned while waiting");
        }
    }

    #[cfg(test)]
    fn admitted_count(&self) -> usize {
        self.state
            .lock()
            .expect("endpoint lifecycle lock poisoned")
            .admitted
    }
}

struct EndpointAdmission {
    lifecycle: Arc<EndpointLifecycle>,
    cancellation: watch::Receiver<bool>,
}

impl EndpointAdmission {
    fn is_cancelled(&self) -> bool {
        *self.cancellation.borrow()
    }

    async fn cancelled(&mut self) {
        if self.is_cancelled() {
            return;
        }
        let _ = self.cancellation.changed().await;
    }

    fn can_publish(&self) -> bool {
        !self
            .lifecycle
            .state
            .lock()
            .expect("endpoint lifecycle lock poisoned")
            .shutting_down
    }

    fn publish_if_active<T, R>(&self, value: T, publish: impl FnOnce(T) -> R) -> Result<R, T> {
        let state = self
            .lifecycle
            .state
            .lock()
            .expect("endpoint lifecycle lock poisoned");
        if state.shutting_down {
            return Err(value);
        }
        Ok(publish(value))
    }
}

impl Drop for EndpointAdmission {
    fn drop(&mut self) {
        let mut state = self
            .lifecycle
            .state
            .lock()
            .expect("endpoint lifecycle lock poisoned");
        state.admitted = state.admitted.saturating_sub(1);
        if state.admitted == 0 {
            self.lifecycle.settled.notify_all();
        }
    }
}

enum MachineTunnelKind {
    Raw(MachineTunnel),
    Http(MachineHttpTunnel),
    GuestHttp(NativeHttpLease),
}

impl MachineTunnelKind {
    fn status(&self) -> MachineTunnelStatus {
        match self {
            Self::Raw(tunnel) => tunnel.status(),
            Self::Http(tunnel) => tunnel.status(),
            Self::GuestHttp(tunnel) => tunnel.status(),
        }
    }

    async fn stop_and_wait(self) {
        match self {
            Self::Raw(tunnel) => tunnel.stop_and_wait().await,
            Self::Http(tunnel) => tunnel.stop_and_wait().await,
            Self::GuestHttp(tunnel) => tunnel.stop_and_wait().await,
        }
    }
}

#[cfg(feature = "test-relay-fixture")]
enum TestTopology {
    Automatic,
    DirectOnly,
    RelayOnly {
        relay_url: String,
        // The one local relay owner stops when this drop guard is released.
        // Its concrete type is erased so the lifecycle crate does not grow a
        // second relay-server API.
        _relay_server: Option<Box<dyn Any + Send>>,
    },
}

#[cfg(feature = "test-relay-fixture")]
struct TestFixtureState {
    topology: TestTopology,
    observed_path: &'static str,
}

/// The one process runtime: shared endpoints, acceptors, and tunnel leases.
/// Direct lifecycle state only — no registry framework.
struct NativeRuntime {
    manager: EndpointManager,
    endpoint_handles: Mutex<HashMap<String, EndpointHandleEntry>>,
    acceptors: Mutex<HashMap<String, AcceptorEntry>>,
    tunnels: Mutex<HashMap<String, TunnelLease>>,
    machine_acceptors: Mutex<HashMap<String, MachineAcceptorEntry>>,
    machine_tunnels: Mutex<HashMap<String, MachineTunnelLease>>,
    next_id: AtomicU64,
    #[cfg(feature = "test-relay-fixture")]
    test_operation: Mutex<()>,
    #[cfg(feature = "test-relay-fixture")]
    test_fixture: Mutex<TestFixtureState>,
}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();
static STATE: OnceLock<NativeRuntime> = OnceLock::new();

fn runtime() -> &'static Runtime {
    RUNTIME.get_or_init(|| {
        Builder::new_multi_thread()
            // One background event loop serves async network I/O; lifecycle waits use the blocking pool.
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("Iroh runtime must build")
    })
}

/// Execute a host binding's synchronous lifecycle call without occupying the
/// host's filesystem/DNS worker pool. The call still enters this same runtime
/// and state owner through the existing JSON ABI.
pub fn spawn_lifecycle_operation(operation: impl FnOnce() + Send + 'static) {
    runtime().spawn_blocking(operation);
}

fn state() -> &'static NativeRuntime {
    STATE.get_or_init(|| NativeRuntime {
        manager: EndpointManager::new(),
        endpoint_handles: Mutex::new(HashMap::new()),
        acceptors: Mutex::new(HashMap::new()),
        tunnels: Mutex::new(HashMap::new()),
        machine_acceptors: Mutex::new(HashMap::new()),
        machine_tunnels: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        #[cfg(feature = "test-relay-fixture")]
        test_operation: Mutex::new(()),
        #[cfg(feature = "test-relay-fixture")]
        test_fixture: Mutex::new(TestFixtureState {
            topology: TestTopology::Automatic,
            observed_path: "unknown",
        }),
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_millis() as u64)
        .unwrap_or(0)
}

fn next_id() -> String {
    format!("iroh-{}", state().next_id.fetch_add(1, Ordering::Relaxed))
}

fn response(value: Value) -> *mut c_char {
    CString::new(value.to_string())
        .expect("JSON has no NUL bytes")
        .into_raw()
}

type OpError = (&'static str, String);

fn parse_json<T: for<'de> Deserialize<'de>>(value: *const c_char) -> Result<T, OpError> {
    if value.is_null() {
        return Err(("invalid-request", "request is required".to_owned()));
    }
    let raw = unsafe { CStr::from_ptr(value) }
        .to_str()
        .map_err(|_| ("invalid-request", "request is not UTF-8".to_owned()))?;
    serde_json::from_str(raw).map_err(|error| ("invalid-request", error.to_string()))
}

fn error_response(code: &str, message: impl Into<String>) -> Value {
    json!({"ok": false, "error": {"code": code, "message": message.into()}})
}

fn invoke_json_request(request: &str, operation: fn(*const c_char) -> Value) -> Value {
    let request = match CString::new(request) {
        Ok(request) => request,
        Err(_) => return error_response("invalid-request", "request contains a NUL byte"),
    };
    operation(request.as_ptr())
}

/// Copies a C UTF-8 request before returning to safe Rust.
fn c_request_string(value: *const c_char) -> Result<String, OpError> {
    if value.is_null() {
        return Err(("invalid-request", "request is required".to_owned()));
    }
    unsafe { CStr::from_ptr(value) }
        .to_str()
        .map(str::to_owned)
        .map_err(|_| ("invalid-request", "request is not UTF-8".to_owned()))
}

fn parse_relay_policy(value: &str) -> Result<RelayPolicy, &'static str> {
    match value {
        "automatic" => Ok(RelayPolicy::Automatic),
        "disabled" => Ok(RelayPolicy::Disabled),
        _ => Err("relayPolicy must be automatic or disabled"),
    }
}

fn parse_cap_profile(value: &str) -> Result<IrohCapProfile, &'static str> {
    IrohCapProfile::parse(value).map_err(|_| "capProfile must be homeInteractive or machineBulk")
}

fn key_path_option(value: &Option<String>) -> Result<Option<PathBuf>, &'static str> {
    match value {
        Some(path) if path.trim().is_empty() => Err("endpointKeyPath must not be empty"),
        Some(path) => Ok(Some(PathBuf::from(path))),
        None => Ok(None),
    }
}

fn endpoint_seed_option(value: &mut Option<String>) -> Result<Option<EndpointSeed>, &'static str> {
    let Some(mut encoded) = value.take() else {
        return Ok(None);
    };
    if encoded.is_empty() {
        encoded.zeroize();
        return Err("endpoint seed is invalid");
    }
    let decoded = BASE64_STANDARD.decode(encoded.as_bytes());
    encoded.zeroize();
    let mut decoded = decoded.map_err(|_| "endpoint seed is invalid")?;
    if decoded.len() != 32 {
        decoded.zeroize();
        return Err("endpoint seed is invalid");
    }
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&decoded);
    decoded.zeroize();
    Ok(Some(EndpointSeed::from_bytes(bytes)))
}

/// Corrupt existing identity keys fail closed before any transport starts; a
/// missing key is provisioned exactly once on first use with restrictive
/// permissions.
fn ensure_endpoint_key(key_path: Option<&Path>) -> Result<(), OpError> {
    if let Some(path) = key_path {
        EndpointKeyStore::ensure(path).map_err(|_| {
            (
                "endpoint_key_unavailable",
                "endpoint identity key is missing or corrupt; endpoint-identity recovery is required"
                    .to_owned(),
            )
        })?;
    }
    Ok(())
}

fn endpoint_handle_for(key_path: Option<&Path>) -> String {
    match key_path {
        Some(path) => path.to_string_lossy().into_owned(),
        None => next_id(),
    }
}

/// Keyless handles map to unshared ephemeral identities (first-provisioning
/// and test callers only; production always passes key paths).
fn ephemeral_identity() -> EndpointIdentity {
    static NEXT_EPHEMERAL: AtomicU64 = AtomicU64::new(1);
    EndpointIdentity::Ephemeral(NEXT_EPHEMERAL.fetch_add(1, Ordering::Relaxed))
}

fn endpoint_identity_for(handle: &str) -> Option<EndpointIdentity> {
    state()
        .endpoint_handles
        .lock()
        .expect("endpoint handle lock poisoned")
        .get(handle)
        .map(|entry| entry.identity.clone())
}

fn begin_endpoint_create(
    handle: &str,
    identity: EndpointIdentity,
) -> Result<EndpointAdmission, Value> {
    let mut handles = state()
        .endpoint_handles
        .lock()
        .expect("endpoint handle lock poisoned");
    let lifecycle = match handles.get(handle) {
        Some(existing) if existing.identity != identity => {
            return Err(error_response(
                "endpoint_config_conflict",
                "endpoint handle is already bound to another identity",
            ));
        }
        Some(existing) => Arc::clone(&existing.lifecycle),
        None => {
            let lifecycle = Arc::new(EndpointLifecycle::new());
            handles.insert(
                handle.to_owned(),
                EndpointHandleEntry {
                    identity,
                    lifecycle: Arc::clone(&lifecycle),
                },
            );
            lifecycle
        }
    };
    lifecycle
        .try_admit()
        .ok_or_else(|| error_response("cancelled", "Iroh endpoint shutdown has already started"))
}

fn admit_endpoint_work(handle: &str) -> Result<(EndpointIdentity, EndpointAdmission), Value> {
    let handles = state()
        .endpoint_handles
        .lock()
        .expect("endpoint handle lock poisoned");
    let Some(entry) = handles.get(handle) else {
        return Err(error_response("not-found", "endpointHandle is unknown"));
    };
    let admission = entry
        .lifecycle
        .try_admit()
        .ok_or_else(|| error_response("cancelled", "Iroh endpoint shutdown has already started"))?;
    Ok((entry.identity.clone(), admission))
}

fn endpoint_config(
    key_path: Option<PathBuf>,
    key_seed: Option<EndpointSeed>,
    relay_policy: RelayPolicy,
    relay_urls: Vec<String>,
    caps: IrohCapProfile,
) -> EndpointConfig {
    let config = EndpointConfig {
        key_path,
        key_seed,
        relay_policy,
        relay_urls,
        caps,
        disable_ip_transports: false,
        ..EndpointConfig::default()
    };
    #[cfg(feature = "test-relay-fixture")]
    {
        let mut config = config;
        let fixture = state()
            .test_fixture
            .lock()
            .expect("test fixture lock poisoned");
        match &fixture.topology {
            TestTopology::Automatic => {}
            TestTopology::DirectOnly => {
                config.relay_policy = RelayPolicy::Disabled;
                config.relay_urls.clear();
            }
            TestTopology::RelayOnly { relay_url, .. } => {
                config.relay_policy = RelayPolicy::Automatic;
                config.relay_urls = vec![relay_url.clone()];
                config.disable_ip_transports = true;
            }
        }
        return config;
    }
    #[cfg(not(feature = "test-relay-fixture"))]
    config
}

#[cfg(feature = "test-relay-fixture")]
fn test_fixture_has_active_endpoints() -> bool {
    !state()
        .endpoint_handles
        .lock()
        .expect("endpoint handle lock poisoned")
        .is_empty()
}

#[cfg(feature = "test-relay-fixture")]
fn test_fixture_busy_response() -> Value {
    error_response(
        "test-fixture-busy",
        "Iroh test topology cannot change while native endpoints are active",
    )
}

#[cfg(feature = "test-relay-fixture")]
fn force_direct_only_for_tests() -> Value {
    let _operation = state()
        .test_operation
        .lock()
        .expect("test operation lock poisoned");
    if test_fixture_has_active_endpoints() {
        return test_fixture_busy_response();
    }
    let mut fixture = state()
        .test_fixture
        .lock()
        .expect("test fixture lock poisoned");
    fixture.topology = TestTopology::DirectOnly;
    fixture.observed_path = "unknown";
    json!({"ok": true})
}

#[cfg(feature = "test-relay-fixture")]
fn force_relay_only_for_tests(value: *const c_char) -> Value {
    let input = match parse_json::<ForceRelayOnlyRequest>(value) {
        Ok(input) => input,
        Err((code, message)) => return error_response(&code, message),
    };
    let _operation = state()
        .test_operation
        .lock()
        .expect("test operation lock poisoned");
    if test_fixture_has_active_endpoints() {
        return test_fixture_busy_response();
    }
    // The same topology owner may use the local stock test relay or an
    // externally started stock relay (the source Docker journey). Both clear
    // IP transports below, making the observed relay path decisive.
    let (relay_url, relay_server): (String, Option<Box<dyn Any + Send>>) =
        if let Some(relay_url) = input.relay_url {
            if RelaySelection::resolve(&RelayPolicy::Automatic, &[relay_url.clone()]).is_err() {
                return error_response("invalid-request", "test relayUrl is invalid");
            }
            (relay_url, None)
        } else {
            let server = match runtime().block_on(happier_iroh_core::LocalTestRelay::spawn()) {
                Ok(value) => value,
                Err(error) => {
                    return error_response(
                        "test-fixture-unavailable",
                        format!("local Iroh test relay failed to start: {error}"),
                    )
                }
            };
            (server.url_string(), Some(Box::new(server)))
        };
    let mut fixture = state()
        .test_fixture
        .lock()
        .expect("test fixture lock poisoned");
    fixture.topology = TestTopology::RelayOnly {
        relay_url,
        _relay_server: relay_server,
    };
    fixture.observed_path = "unknown";
    json!({"ok": true})
}

#[cfg(feature = "test-relay-fixture")]
fn restore_automatic_for_tests() -> Value {
    let _operation = state()
        .test_operation
        .lock()
        .expect("test operation lock poisoned");
    if test_fixture_has_active_endpoints() {
        return test_fixture_busy_response();
    }
    let mut fixture = state()
        .test_fixture
        .lock()
        .expect("test fixture lock poisoned");
    fixture.topology = TestTopology::Automatic;
    fixture.observed_path = "unknown";
    json!({"ok": true})
}

#[cfg(feature = "test-relay-fixture")]
fn record_test_observed_path(observed_path: &'static str) {
    let mut fixture = state()
        .test_fixture
        .lock()
        .expect("test fixture lock poisoned");
    fixture.observed_path = observed_path;
}

#[cfg(feature = "test-relay-fixture")]
fn test_observed_path() -> &'static str {
    state()
        .test_fixture
        .lock()
        .expect("test fixture lock poisoned")
        .observed_path
}

#[cfg(feature = "test-relay-fixture")]
fn test_relay_url() -> Option<String> {
    let fixture = state()
        .test_fixture
        .lock()
        .expect("test fixture lock poisoned");
    match &fixture.topology {
        TestTopology::RelayOnly { relay_url, .. } => Some(relay_url.clone()),
        TestTopology::Automatic | TestTopology::DirectOnly => None,
    }
}

/// Creates or returns the shared process endpoint for a handle. The
/// application relay policy is stable; explicit automatic-policy relays are
/// unioned by the core and outgoing flow caps are connection-local.
async fn acquire_shared_endpoint(
    identity: EndpointIdentity,
    config: EndpointConfig,
) -> Result<std::sync::Arc<IrohEndpoint>, Value> {
    match state().manager.acquire_identified(identity, &config).await {
        Ok(endpoint) => Ok(endpoint),
        Err(happier_iroh_core::IrohError::EndpointConfigConflict) => Err(error_response(
            "endpoint_config_conflict",
            "endpoint identity already bound with an incompatible relay policy or transport mode",
        )),
        Err(_) => Err(error_response(
            "transport-unavailable",
            "Iroh endpoint bind failed",
        )),
    }
}

fn tunnel_start_error(error: happier_iroh_core::IrohError) -> Value {
    use happier_iroh_core::IrohError;
    match error {
        IrohError::InvalidDescriptor => {
            error_response("invalid_descriptor", "Home tunnel descriptor is invalid")
        }
        IrohError::UnsupportedAlpn => {
            error_response("unsupported_alpn", "Home tunnel ALPN is unsupported")
        }
        IrohError::InvalidPreamble => {
            error_response("invalid_preamble", "Home tunnel preamble is invalid")
        }
        IrohError::EndpointConfigConflict => error_response(
            "endpoint_config_conflict",
            "Home tunnel endpoint configuration conflicts with the shared endpoint",
        ),
        IrohError::ResourceLimit => {
            error_response("resource_limit", "Home tunnel resource limit reached")
        }
        IrohError::LoopbackBindFailed => {
            error_response("loopback_bind_failed", "Home tunnel loopback bind failed")
        }
        IrohError::EndpointIdentityMismatch => error_response(
            "endpoint-identity-mismatch",
            "Home tunnel remote identity does not match the requested endpoint",
        ),
        IrohError::TransportTimeout => {
            error_response("transport_timeout", "Home tunnel transport timed out")
        }
        IrohError::TransportUnreachable => {
            error_response("home_unreachable", "Home tunnel has no reachable address")
        }
        IrohError::TransportClosed => {
            error_response("transport_closed", "Home tunnel transport closed")
        }
        IrohError::Cancelled => error_response("cancelled", "Home tunnel start was cancelled"),
        IrohError::Io(_) => error_response(
            "transport-unavailable",
            "Home tunnel transport is unavailable",
        ),
    }
}

fn machine_start_error(error: happier_iroh_core::IrohError) -> Value {
    use happier_iroh_core::IrohError;
    match error {
        IrohError::InvalidDescriptor => error_response(
            "machine-control-invalid",
            "machine handshake control is invalid",
        ),
        IrohError::UnsupportedAlpn => {
            error_response("unsupported-alpn", "machine ALPN is unsupported")
        }
        IrohError::InvalidPreamble => {
            error_response("invalid-preamble", "machine stream preamble is invalid")
        }
        IrohError::EndpointConfigConflict => error_response(
            "endpoint_config_conflict",
            "machine endpoint configuration conflicts with the shared endpoint",
        ),
        IrohError::ResourceLimit => {
            error_response("resource-limit", "machine carrier resource limit reached")
        }
        IrohError::LoopbackBindFailed => error_response(
            "loopback-bind-failed",
            "machine tunnel loopback bind failed",
        ),
        IrohError::EndpointIdentityMismatch => error_response(
            happier_iroh_core::MachineFailureCode::EndpointIdentityMismatch.as_str(),
            "machine tunnel remote identity does not match the requested endpoint",
        ),
        IrohError::Cancelled => error_response("cancelled", "machine tunnel start was cancelled"),
        _ => error_response("transport-unavailable", "machine transport is unavailable"),
    }
}

fn observed_path_string(tunnel: &HomeTunnel) -> &'static str {
    tunnel
        .status()
        .observed_path
        .map(|snapshot| snapshot.observed_path.as_str())
        .unwrap_or("unknown")
}

fn insert_lease(
    tunnel_id: String,
    home_server_identity_id: String,
    endpoint_handle: String,
    tunnel: HomeTunnel,
) -> (String, String, u64, &'static str) {
    let runtime_origin = tunnel.local_origin().unwrap_or_default();
    let observed_path = observed_path_string(&tunnel);
    #[cfg(feature = "test-relay-fixture")]
    record_test_observed_path(observed_path);
    let started_at_ms = now_ms();
    state().tunnels.lock().expect("lease lock poisoned").insert(
        tunnel_id.clone(),
        TunnelLease {
            home_server_identity_id: home_server_identity_id.clone(),
            endpoint_handle: endpoint_handle.clone(),
            tunnel,
            runtime_origin: runtime_origin.clone(),
            started_at_ms,
        },
    );
    (tunnel_id, runtime_origin, started_at_ms, observed_path)
}

// ---------------------------------------------------------------------------
// Handle-based lifecycle ops (plan §7.4)
// ---------------------------------------------------------------------------

fn create_endpoint(value: *const c_char) -> Value {
    let mut input = match parse_json::<CreateEndpointRequest>(value) {
        Ok(v) => v,
        Err((code, message)) => return error_response(&code, message),
    };
    let relay_policy = match parse_relay_policy(&input.relay_policy) {
        Ok(v) => v,
        Err(message) => return error_response("invalid-request", message),
    };
    let caps = match parse_cap_profile(&input.cap_profile) {
        Ok(v) => v,
        Err(message) => return error_response("invalid-request", message),
    };
    let relay_selection_valid = RelaySelection::resolve(&relay_policy, &input.relay_urls);
    if relay_selection_valid.is_err() {
        return error_response("invalid-request", "relayUrls entry is invalid");
    }
    let key_path = match key_path_option(&input.key_path) {
        Ok(v) => v,
        Err(message) => return error_response("invalid-request", message),
    };
    let key_seed = match endpoint_seed_option(&mut input.endpoint_seed_base64) {
        Ok(value) => value,
        Err(message) => return error_response("invalid-request", message),
    };
    if key_path.is_some() && key_seed.is_some() {
        return error_response(
            "invalid-request",
            "keyPath and native endpoint seed are mutually exclusive",
        );
    }
    let handle = match &key_seed {
        Some(seed) => format!("mobile:{}", seed.endpoint_id()),
        None => endpoint_handle_for(key_path.as_deref()),
    };
    let identity = match (&key_path, &key_seed) {
        (Some(path), _) => EndpointIdentity::Keyed(path.clone()),
        (None, Some(seed)) => EndpointIdentity::Seeded(seed.endpoint_id()),
        (None, None) => ephemeral_identity(),
    };
    let (mut admission, config) = {
        #[cfg(feature = "test-relay-fixture")]
        let _test_operation = state()
            .test_operation
            .lock()
            .expect("test operation lock poisoned");
        let admission = match begin_endpoint_create(&handle, identity.clone()) {
            Ok(admission) => admission,
            Err(error) => return error,
        };
        // Key provisioning is endpoint work too. Admit it only after the
        // lifecycle boundary has closed the create-vs-shutdown race, so a
        // create refused during shutdown performs no key-store I/O first.
        if let Err((code, message)) = ensure_endpoint_key(key_path.as_deref()) {
            return error_response(code, message);
        }
        let config = endpoint_config(
            key_path,
            key_seed,
            relay_policy,
            input.relay_urls.clone(),
            caps,
        );
        (admission, config)
    };
    let endpoint = match runtime().block_on(async {
        tokio::select! {
            result = acquire_shared_endpoint(identity.clone(), config) => result,
            _ = admission.cancelled() => Err(error_response(
                "cancelled",
                "Iroh endpoint creation was cancelled by shutdown",
            )),
        }
    }) {
        Ok(endpoint) => endpoint,
        Err(error) => return error,
    };
    if !admission.can_publish() {
        runtime().block_on(state().manager.shutdown(&identity));
        return error_response(
            "cancelled",
            "Iroh endpoint creation was cancelled by shutdown",
        );
    }
    // Report one coherent snapshot of the configuration that the native
    // endpoint actually applied. A later Home may add another explicit relay,
    // so reading relay mode and URLs through separate locks could otherwise
    // expose a combination that never existed.
    let applied = endpoint.resolved_config();
    json!({"ok": true, "result": {
        "endpointHandle": handle,
        "endpointId": endpoint.id().to_string(),
        "relayPolicy": applied.relay_policy.as_str(),
        "relayMode": applied.relay.mode(),
        "capProfile": applied.caps.id(),
        "relayUrls": applied.relay.relay_urls().iter().map(|url| url.to_string()).collect::<Vec<_>>(),
    }})
}

/// Safe JSON entry point used by Rust-native desktop hosts. The C ABI wrapper
/// delegates to the same operation so endpoint creation has one owner.
pub fn create_endpoint_json(request: &str) -> Value {
    invoke_json_request(request, create_endpoint)
}

fn start_home_acceptor(value: *const c_char) -> Value {
    let input = match parse_json::<StartHomeAcceptorRequest>(value) {
        Ok(v) => v,
        Err((code, message)) => return error_response(&code, message),
    };
    if validate_loopback_target(&input.target_host, input.target_port).is_err() {
        return error_response(
            "loopback-bind-failed",
            "Home acceptor target must be a loopback address with a concrete port",
        );
    }
    let target_ip: IpAddr = if input.target_host == "localhost" {
        IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
    } else {
        match input.target_host.parse() {
            Ok(ip) => ip,
            Err(_) => return error_response("invalid-request", "targetHost is not an IP address"),
        }
    };
    let target = SocketAddr::new(target_ip, input.target_port);
    let (identity, admission) = match admit_endpoint_work(&input.endpoint_handle) {
        Ok(admitted) => admitted,
        Err(error) => return error,
    };
    let Some((_, endpoint)) = state().manager.get(&identity) else {
        return error_response("not-found", "endpoint is shut down");
    };
    let mut acceptors = state().acceptors.lock().expect("acceptor lock poisoned");
    if let Some(existing) = acceptors.get(&input.endpoint_handle) {
        if !admission.can_publish() {
            return error_response("cancelled", "Home acceptor start was cancelled");
        }
        if existing.target == target {
            return json!({"ok": true, "result": {
                "endpointHandle": input.endpoint_handle,
                "reused": true,
                "status": acceptor_status_json(existing.acceptor.status()),
            }});
        }
        return error_response(
            "endpoint_config_conflict",
            "an acceptor is already running for this endpoint with a different loopback target",
        );
    }
    // HomeAcceptor::start owns a Tokio accept task. The C ABI is synchronous,
    // so enter the process runtime explicitly before it spawns that task.
    let _runtime_guard = runtime().enter();
    match HomeAcceptor::start(&endpoint, HomeAcceptorConfig { target }) {
        Ok(acceptor) => {
            let status = acceptor.status();
            let published = admission.publish_if_active(acceptor, |acceptor| {
                acceptors.insert(
                    input.endpoint_handle.clone(),
                    AcceptorEntry { acceptor, target },
                );
            });
            if let Err(acceptor) = published {
                runtime().block_on(acceptor.stop_and_wait());
                return error_response("cancelled", "Home acceptor start was cancelled");
            }
            json!({"ok": true, "result": {
                "endpointHandle": input.endpoint_handle,
                "reused": false,
                "status": acceptor_status_json(status),
            }})
        }
        Err(_) => error_response("loopback-bind-failed", "Home acceptor failed to start"),
    }
}

fn stop_home_acceptor(value: *const c_char) -> Value {
    let input = match parse_json::<EndpointHandleRequest>(value) {
        Ok(v) => v,
        Err((code, message)) => return error_response(&code, message),
    };
    if let Some(entry) = state()
        .acceptors
        .lock()
        .expect("acceptor lock poisoned")
        .remove(&input.endpoint_handle)
    {
        runtime().block_on(entry.acceptor.stop_and_wait());
    }
    json!({"ok": true})
}

fn ensure_home_tunnel(value: *const c_char) -> Value {
    let input = match parse_json::<EnsureTunnelRequest>(value) {
        Ok(v) => v,
        Err((code, message)) => return error_response(&code, message),
    };
    if input.home_server_identity_id.trim().is_empty() {
        return error_response("invalid-request", "homeServerIdentityId is required");
    }
    if validate_endpoint_id(&input.endpoint_id).is_err() {
        return error_response("invalid-request", "endpointId is invalid");
    }
    let (identity, mut admission) = match admit_endpoint_work(&input.endpoint_handle) {
        Ok(admitted) => admitted,
        Err(error) => return error,
    };
    let Some((config, endpoint)) = state().manager.get(&identity) else {
        return error_response("not-found", "endpoint is shut down");
    };
    // Tunnel relay hints respect the endpoint's relay selection: a direct-only
    // endpoint never contacts descriptor relays; an automatic endpoint uses the
    // request's validated hints, falling back to its own configured relays.
    let tunnel_hints = match &config.relay {
        RelaySelection::Disabled => Vec::new(),
        RelaySelection::Custom(_) => {
            let requested =
                match RelaySelection::resolve(&RelayPolicy::Automatic, &input.relay_urls) {
                    Ok(selection) => selection,
                    Err(_) => {
                        return error_response("invalid-request", "relayUrls entry is invalid")
                    }
                };
            if requested.relay_urls().is_empty() {
                config.relay.relay_urls().to_vec()
            } else {
                requested.relay_urls().to_vec()
            }
        }
    };
    let tunnel = match runtime().block_on(async {
        tokio::select! {
            result = HomeTunnel::start(
                &endpoint,
                HomeTunnelConfig {
                    endpoint_id: input.endpoint_id.clone(),
                    direct_addresses: input.direct_addresses.clone(),
                    relay_urls: tunnel_hints,
                    ..HomeTunnelConfig::default()
                },
            ) => result,
            _ = admission.cancelled() => Err(happier_iroh_core::IrohError::Cancelled),
        }
    }) {
        Ok(tunnel) => tunnel,
        Err(error) => return tunnel_start_error(error),
    };
    let published = admission.publish_if_active(tunnel, |tunnel| {
        insert_lease(
            next_id(),
            input.home_server_identity_id.clone(),
            input.endpoint_handle.clone(),
            tunnel,
        )
    });
    let (tunnel_id, runtime_origin, started_at_ms, observed_path) = match published {
        Ok(published) => published,
        Err(tunnel) => {
            runtime().block_on(tunnel.stop_and_wait());
            return tunnel_start_error(happier_iroh_core::IrohError::Cancelled);
        }
    };
    json!({"ok": true, "result": {
        "tunnelId": tunnel_id,
        "homeServerIdentityId": input.home_server_identity_id,
        "homeEndpointId": input.endpoint_id,
        "runtimeOrigin": runtime_origin,
        "carrier": "iroh",
        "observedPath": observed_path,
        "startedAtMs": started_at_ms,
        "endpointHandle": input.endpoint_handle,
    }})
}

/// Safe JSON entry point used by Rust-native desktop hosts.
pub fn ensure_home_tunnel_json(request: &str) -> Value {
    invoke_json_request(request, ensure_home_tunnel)
}

fn release_home_tunnel(value: *const c_char) -> Value {
    let input = match parse_json::<TunnelHandleRequest>(value) {
        Ok(v) => v,
        Err((code, message)) => return error_response(&code, message),
    };
    if let Some(lease) = state()
        .tunnels
        .lock()
        .expect("lease lock poisoned")
        .remove(&input.tunnel_id)
    {
        runtime().block_on(lease.tunnel.stop_and_wait());
    }
    json!({"ok": true})
}

/// Safe JSON entry point used by Rust-native desktop hosts.
pub fn release_home_tunnel_json(request: &str) -> Value {
    invoke_json_request(request, release_home_tunnel)
}

fn loopback_target(host: &str, port: u16) -> Result<SocketAddr, Value> {
    if validate_loopback_target(host, port).is_err() {
        return Err(error_response(
            "loopback-bind-failed",
            "target must be a fixed loopback address with a concrete port",
        ));
    }
    let ip = if host == "localhost" {
        IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
    } else {
        host.parse()
            .map_err(|_| error_response("invalid-request", "target host is not an IP address"))?
    };
    Ok(SocketAddr::new(ip, port))
}

fn start_machine_acceptor(value: *const c_char) -> Value {
    let input = match parse_json::<StartMachineAcceptorRequest>(value) {
        Ok(value) => value,
        Err((code, message)) => return error_response(code, message),
    };
    let admission_target = match loopback_target(&input.admission_host, input.admission_port) {
        Ok(value) => value,
        Err(error) => return error,
    };
    let (identity, admission) = match admit_endpoint_work(&input.endpoint_handle) {
        Ok(admitted) => admitted,
        Err(error) => return error,
    };
    let Some((_, endpoint)) = state().manager.get(&identity) else {
        return error_response("not-found", "endpoint is shut down");
    };
    let mut acceptors = state()
        .machine_acceptors
        .lock()
        .expect("machine acceptor lock poisoned");
    if let Some(existing) = acceptors.get(&input.endpoint_handle) {
        if !admission.can_publish() {
            return error_response("cancelled", "machine acceptor start was cancelled");
        }
        if existing.admission_target == admission_target {
            return json!({"ok": true, "result": {"endpointHandle": input.endpoint_handle, "reused": true, "status": machine_acceptor_status_json(existing.acceptor.status())}});
        }
        return error_response(
            "endpoint_config_conflict",
            "a machine acceptor is already running with a different fixed admission target",
        );
    }
    let _guard = runtime().enter();
    match MachineAcceptor::start(&endpoint, MachineAcceptorConfig { admission_target }) {
        Ok(acceptor) => {
            let status = acceptor.status();
            let published = admission.publish_if_active(acceptor, |acceptor| {
                acceptors.insert(
                    input.endpoint_handle.clone(),
                    MachineAcceptorEntry {
                        acceptor,
                        admission_target,
                    },
                );
            });
            if let Err(acceptor) = published {
                runtime().block_on(acceptor.stop_and_wait());
                return error_response("cancelled", "machine acceptor start was cancelled");
            }
            json!({"ok": true, "result": {"endpointHandle": input.endpoint_handle, "reused": false, "status": machine_acceptor_status_json(status)}})
        }
        Err(_) => error_response("transport-unavailable", "machine acceptor failed to start"),
    }
}

fn stop_machine_acceptor(value: *const c_char) -> Value {
    let input = match parse_json::<EndpointHandleRequest>(value) {
        Ok(value) => value,
        Err((code, message)) => return error_response(code, message),
    };
    let entry = state()
        .machine_acceptors
        .lock()
        .expect("machine acceptor lock poisoned")
        .remove(&input.endpoint_handle);
    if let Some(entry) = entry {
        runtime().block_on(entry.acceptor.stop_and_wait());
    }
    json!({"ok": true})
}

fn start_machine_tunnel(value: *const c_char) -> Value {
    let input = match parse_json::<StartMachineTunnelRequest>(value) {
        Ok(value) => value,
        Err((code, message)) => return error_response(code, message),
    };
    if validate_endpoint_id(&input.endpoint_id).is_err() {
        return error_response("invalid-request", "endpointId is invalid");
    }
    let (identity, mut admission) = match admit_endpoint_work(&input.endpoint_handle) {
        Ok(admitted) => admitted,
        Err(error) => return error,
    };
    let Some((config, endpoint)) = state().manager.get(&identity) else {
        return error_response("not-found", "endpoint is shut down");
    };
    let cap_profile = match parse_cap_profile(&input.cap_profile) {
        Ok(profile @ IrohCapProfile::MachineBulk) => profile,
        _ => return error_response("invalid-request", "machine capProfile must be machineBulk"),
    };
    let relay_urls = match &config.relay {
        RelaySelection::Disabled => Vec::new(),
        RelaySelection::Custom(_) => {
            match RelaySelection::resolve(&RelayPolicy::Automatic, &input.relay_urls) {
                Ok(selection) if selection.relay_urls().is_empty() => {
                    config.relay.relay_urls().to_vec()
                }
                Ok(selection) => selection.relay_urls().to_vec(),
                Err(_) => return error_response("invalid-request", "relayUrls entry is invalid"),
            }
        }
    };
    let tunnel = match runtime().block_on(async {
        tokio::select! {
            result = async {
                let config = MachineTunnelConfig {
                    endpoint_id: input.endpoint_id,
                    bind_addr: "127.0.0.1:0".parse().expect("fixed loopback"),
                    direct_addresses: input.direct_addresses,
                    relay_urls,
                    handshake_json: input.handshake_json,
                    cap_profile,
                };
                match input.native_http_lease {
                    Some(lease) => NativeHttpLease::start(&endpoint, config, &lease.open_json).await.map(MachineTunnelKind::GuestHttp),
                    None => MachineTunnel::start(&endpoint, config).await.map(MachineTunnelKind::Raw),
                }
            } => result,
            _ = admission.cancelled() => Err(happier_iroh_core::IrohError::Cancelled),
        }
    }) {
        Ok(tunnel) => tunnel,
        Err(error) => return machine_start_error(error),
    };
    let id = next_id();
    let status = tunnel.status();
    let tunnel_local_capability = match &tunnel {
        MachineTunnelKind::Raw(tunnel) => tunnel.local_capability().map(str::to_owned),
        _ => None,
    };
    let started_at_ms = now_ms();
    let published = admission.publish_if_active(tunnel, |tunnel| {
        state()
            .machine_tunnels
            .lock()
            .expect("machine tunnel lock poisoned")
            .insert(
                id.clone(),
                MachineTunnelLease {
                    endpoint_handle: input.endpoint_handle.clone(),
                    tunnel,
                    started_at_ms,
                },
            );
    });
    if let Err(tunnel) = published {
        runtime().block_on(tunnel.stop_and_wait());
        return machine_start_error(happier_iroh_core::IrohError::Cancelled);
    }
    let mut result = json!({"machineTunnelId": id, "endpointHandle": input.endpoint_handle, "localPort": status.local_port, "connectionActive": status.connection_active, "remoteEndpointId": status.remote_endpoint_id, "observedPath": status.observed_path.observed_path.as_str(), "lastErrorCode": status.last_failure.map(|failure| failure.as_str()), "startedAtMs": started_at_ms});
    add_optional_local_capability(&mut result, tunnel_local_capability);
    json!({"ok": true, "result": result})
}

fn add_optional_local_capability(result: &mut Value, local_capability: Option<String>) {
    if let Some(local_capability) = local_capability {
        result["localCapability"] = Value::String(local_capability);
    }
}

fn start_machine_http_tunnel(value: *const c_char) -> Value {
    let input = match parse_json::<StartMachineTunnelRequest>(value) {
        Ok(value) => value,
        Err((code, message)) => return error_response(code, message),
    };
    start_machine_http_tunnel_input(input, None)
}

fn start_machine_http_tunnel_input(
    input: StartMachineTunnelRequest,
    handshake_provider: Option<MachineHandshakeProvider>,
) -> Value {
    if input.native_http_lease.is_some() {
        return error_response("invalid-request", "nativeHttpLease requires startMachineTunnel");
    }
    if validate_endpoint_id(&input.endpoint_id).is_err() {
        return error_response("invalid-request", "endpointId is invalid");
    }
    let (identity, mut admission) = match admit_endpoint_work(&input.endpoint_handle) {
        Ok(admitted) => admitted,
        Err(error) => return error,
    };
    let Some((config, endpoint)) = state().manager.get(&identity) else {
        return error_response("not-found", "endpoint is shut down");
    };
    // Iroh rejects self dials. Reuse this endpoint's active acceptor rather
    // than a caller-supplied port; its signed admission and withdrawal lifetime
    // remain the same authority for local and remote broker streams.
    let local_admission = if input.endpoint_id == endpoint.id().to_string() {
        let acceptors = state().machine_acceptors.lock().expect("machine acceptor lock poisoned");
        let Some(acceptor) = acceptors.get(&input.endpoint_handle) else {
            return error_response("transport-unavailable", "local machine acceptor is unavailable");
        };
        Some(acceptor.acceptor.local_admission())
    } else { None };
    let cap_profile = match parse_cap_profile(&input.cap_profile) {
        Ok(IrohCapProfile::MachineBulk) => IrohCapProfile::MachineBulk,
        _ => {
            return error_response(
                "invalid-request",
                "machine HTTP capProfile must be machineBulk",
            )
        }
    };
    let relay_urls = match &config.relay {
        RelaySelection::Disabled => Vec::new(),
        RelaySelection::Custom(_) => {
            match RelaySelection::resolve(&RelayPolicy::Automatic, &input.relay_urls) {
                Ok(selection) if selection.relay_urls().is_empty() => {
                    config.relay.relay_urls().to_vec()
                }
                Ok(selection) => selection.relay_urls().to_vec(),
                Err(_) => return error_response("invalid-request", "relayUrls entry is invalid"),
            }
        }
    };
    let tunnel = match runtime().block_on(async {
        tokio::select! {
            result = async {
                let tunnel_config = MachineTunnelConfig {
                    endpoint_id: input.endpoint_id,
                    bind_addr: "127.0.0.1:0".parse().expect("fixed loopback"),
                    direct_addresses: input.direct_addresses,
                    relay_urls,
                    handshake_json: input.handshake_json,
                    cap_profile,
                };
                if let Some(local_admission) = local_admission {
                    MachineHttpTunnel::start_with_local_admission(
                        &endpoint, tunnel_config, local_admission, handshake_provider,
                    ).await
                } else { match handshake_provider {
                    Some(provider) => MachineHttpTunnel::start_with_handshake_provider(
                        &endpoint,
                        tunnel_config,
                        provider,
                    ).await,
                    None => MachineHttpTunnel::start(&endpoint, tunnel_config).await,
                } }
            } => result,
            _ = admission.cancelled() => Err(happier_iroh_core::IrohError::Cancelled),
        }
    }) {
        Ok(tunnel) => tunnel,
        Err(error) => return machine_start_error(error),
    };
    let id = next_id();
    let status = tunnel.status();
    let local_port = tunnel.local_port();
    let local_capability = tunnel.local_capability().to_owned();
    let started_at_ms = now_ms();
    let published = admission.publish_if_active(tunnel, |tunnel| {
        state()
            .machine_tunnels
            .lock()
            .expect("machine tunnel lock poisoned")
            .insert(
                id.clone(),
                MachineTunnelLease {
                    endpoint_handle: input.endpoint_handle.clone(),
                    tunnel: MachineTunnelKind::Http(tunnel),
                    started_at_ms,
                },
            );
    });
    if let Err(tunnel) = published {
        runtime().block_on(tunnel.stop_and_wait());
        return machine_start_error(happier_iroh_core::IrohError::Cancelled);
    }
    json!({"ok": true, "result": {"machineTunnelId": id, "endpointHandle": input.endpoint_handle, "localPort": local_port, "localCapability": local_capability, "connectionActive": status.connection_active, "remoteEndpointId": status.remote_endpoint_id, "observedPath": status.observed_path.observed_path.as_str(), "lastErrorCode": status.last_failure.map(|failure| failure.as_str()), "startedAtMs": started_at_ms}})
}

/// Safe JSON entry point used by Rust-native desktop hosts.
pub fn start_machine_tunnel_json(request: &str) -> Value {
    invoke_json_request(request, start_machine_tunnel)
}

/// Safe JSON entry point used by Rust-native desktop hosts.
pub fn start_machine_http_tunnel_json(request: &str) -> Value {
    invoke_json_request(request, start_machine_http_tunnel)
}

/// Node-only extension of the same native lifecycle owner. Mobile and other
/// released callers retain the static JSON operation; the optional provider
/// changes only how each new HTTP stream obtains its bounded handshake.
pub fn start_machine_http_tunnel_with_handshake_provider_json(
    request: &str,
    handshake_provider: MachineHandshakeProvider,
) -> Value {
    match serde_json::from_str::<StartMachineTunnelRequest>(request) {
        Ok(input) => start_machine_http_tunnel_input(input, Some(handshake_provider)),
        Err(_) => error_response("invalid-request", "request is not valid JSON"),
    }
}

fn stop_machine_tunnel(value: *const c_char) -> Value {
    let input = match parse_json::<MachineTunnelHandleRequest>(value) {
        Ok(value) => value,
        Err((code, message)) => return error_response(code, message),
    };
    let lease = state()
        .machine_tunnels
        .lock()
        .expect("machine tunnel lock poisoned")
        .remove(&input.machine_tunnel_id);
    if let Some(lease) = lease {
        runtime().block_on(lease.tunnel.stop_and_wait());
    }
    json!({"ok": true})
}

/// Safe JSON entry point used by Rust-native desktop hosts.
pub fn stop_machine_tunnel_json(request: &str) -> Value {
    invoke_json_request(request, stop_machine_tunnel)
}

fn wait_machine_tunnel_closed(value: *const c_char) -> Value {
    let input = match parse_json::<MachineTunnelHandleRequest>(value) {
        Ok(value) => value,
        Err((code, message)) => return error_response(code, message),
    };
    // Clone the existing guest task's completion signal under custody, then
    // relinquish the map lock so stop and endpoint teardown can complete it.
    let closed = {
        let tunnels = state().machine_tunnels.lock().expect("machine tunnel lock poisoned");
        match tunnels.get(&input.machine_tunnel_id).map(|lease| &lease.tunnel) {
            Some(MachineTunnelKind::GuestHttp(lease)) => Some(lease.closed_signal()),
            None => None,
            _ => return error_response("invalid-request", "terminal wait requires a guest HTTP lease"),
        }
    };
    if let Some(mut closed) = closed {
        runtime().block_on(async { let _ = closed.changed().await; });
    }
    json!({"ok": true, "result": Value::Null})
}

pub fn wait_machine_tunnel_closed_json(request: &str) -> Value {
    invoke_json_request(request, wait_machine_tunnel_closed)
}

fn get_machine_tunnel_status(value: *const c_char) -> Value {
    let input = match parse_json::<MachineTunnelHandleRequest>(value) {
        Ok(value) => value,
        Err((code, message)) => return error_response(code, message),
    };
    let tunnels = state()
        .machine_tunnels
        .lock()
        .expect("machine tunnel lock poisoned");
    let Some(lease) = tunnels.get(&input.machine_tunnel_id) else {
        return json!({"ok": true, "result": Value::Null});
    };
    let status = lease.tunnel.status();
    json!({"ok": true, "result": {"machineTunnelId": input.machine_tunnel_id, "endpointHandle": lease.endpoint_handle, "localPort": status.local_port, "connectionActive": status.connection_active, "streamsOpened": status.streams_opened, "remoteEndpointId": status.remote_endpoint_id, "observedPath": status.observed_path.observed_path.as_str(), "lastErrorCode": status.last_failure.map(|failure| failure.as_str()), "startedAtMs": lease.started_at_ms}})
}

fn get_machine_acceptor_status(value: *const c_char) -> Value {
    let input = match parse_json::<EndpointHandleRequest>(value) {
        Ok(value) => value,
        Err((code, message)) => return error_response(code, message),
    };
    let acceptors = state()
        .machine_acceptors
        .lock()
        .expect("machine acceptor lock poisoned");
    json!({"ok": true, "result": acceptors.get(&input.endpoint_handle).map(|entry| machine_acceptor_status_json(entry.acceptor.status()))})
}

fn shutdown_endpoint(value: *const c_char) -> Value {
    match c_request_string(value) {
        Ok(request) => shutdown_endpoint_json(&request),
        Err((code, message)) => error_response(&code, message),
    }
}

fn stop_endpoint_resources(endpoint_handle: &str) {
    if let Some(entry) = state()
        .acceptors
        .lock()
        .expect("acceptor lock poisoned")
        .remove(endpoint_handle)
    {
        runtime().block_on(entry.acceptor.stop_and_wait());
    }
    if let Some(entry) = state()
        .machine_acceptors
        .lock()
        .expect("machine acceptor lock poisoned")
        .remove(endpoint_handle)
    {
        runtime().block_on(entry.acceptor.stop_and_wait());
    }
    let bound_leases: Vec<String> = state()
        .tunnels
        .lock()
        .expect("lease lock poisoned")
        .iter()
        .filter(|(_, lease)| lease.endpoint_handle == endpoint_handle)
        .map(|(id, _)| id.clone())
        .collect();
    for lease_id in bound_leases {
        if let Some(lease) = state()
            .tunnels
            .lock()
            .expect("lease lock poisoned")
            .remove(&lease_id)
        {
            runtime().block_on(lease.tunnel.stop_and_wait());
        }
    }
    let machine_leases: Vec<String> = state()
        .machine_tunnels
        .lock()
        .expect("machine tunnel lock poisoned")
        .iter()
        .filter(|(_, lease)| lease.endpoint_handle == endpoint_handle)
        .map(|(id, _)| id.clone())
        .collect();
    for lease_id in machine_leases {
        if let Some(lease) = state()
            .machine_tunnels
            .lock()
            .expect("machine tunnel lock poisoned")
            .remove(&lease_id)
        {
            runtime().block_on(lease.tunnel.stop_and_wait());
        }
    }
}

fn begin_endpoint_shutdown(
    input: &EndpointHandleRequest,
) -> Option<(EndpointIdentity, Arc<EndpointLifecycle>)> {
    {
        #[cfg(feature = "test-relay-fixture")]
        let _test_operation = state()
            .test_operation
            .lock()
            .expect("test operation lock poisoned");
        let found = state()
            .endpoint_handles
            .lock()
            .expect("endpoint handle lock poisoned")
            .get(&input.endpoint_handle)
            .map(|entry| (entry.identity.clone(), Arc::clone(&entry.lifecycle)));
        let (identity, lifecycle) = found?;
        lifecycle.begin_shutdown();
        Some((identity, lifecycle))
    }
}

/// Closes endpoint admission synchronously without performing blocking cleanup.
/// Host bindings call this at their public shutdown invocation boundary so an
/// already-saturated worker pool cannot queue shutdown behind new starts. The
/// aggregate shutdown below remains the sole cleanup/join owner.
pub fn begin_endpoint_shutdown_json(request: &str) -> Value {
    let input = match serde_json::from_str::<EndpointHandleRequest>(request) {
        Ok(v) => v,
        Err(error) => return error_response("invalid-request", error.to_string()),
    };
    let found = begin_endpoint_shutdown(&input).is_some();
    json!({"ok": true, "result": {"found": found}})
}

/// Safe JSON lifecycle entry point for the explicit process shutdown of one
/// endpoint (and its acceptors/leases). The persistent key file is retained;
/// identity is never rotated or deleted.
pub fn shutdown_endpoint_json(request: &str) -> Value {
    let input = match serde_json::from_str::<EndpointHandleRequest>(request) {
        Ok(v) => v,
        Err(error) => return error_response("invalid-request", error.to_string()),
    };
    let Some((identity, lifecycle)) = begin_endpoint_shutdown(&input) else {
        return json!({"ok": true, "result": {"stopped": false}});
    };
    // Close admission before taking any resource snapshot. Endpoint shutdown
    // also wakes outgoing Iroh connects; the per-operation cancellation arm
    // ensures a caller that was admitted earlier settles without publishing a
    // late handle.
    stop_endpoint_resources(&input.endpoint_handle);
    let stopped_before_settle = runtime().block_on(state().manager.shutdown(&identity));
    lifecycle.wait_for_admitted();

    // Admitted work checks the lifecycle before publishing. Sweep again as a
    // defensive owner-boundary invariant and close an endpoint whose bind won
    // the manager race after the first shutdown snapshot.
    stop_endpoint_resources(&input.endpoint_handle);
    let stopped_after_settle = runtime().block_on(state().manager.shutdown(&identity));
    let mut handles = state()
        .endpoint_handles
        .lock()
        .expect("endpoint handle lock poisoned");
    if handles
        .get(&input.endpoint_handle)
        .is_some_and(|entry| Arc::ptr_eq(&entry.lifecycle, &lifecycle))
    {
        handles.remove(&input.endpoint_handle);
    }
    let stopped = stopped_before_settle || stopped_after_settle;
    json!({"ok": true, "result": {"stopped": stopped}})
}

fn acceptor_status_json(status: happier_iroh_core::HomeAcceptorStatus) -> Value {
    json!({
        "running": status.running,
        "connectionsAccepted": status.connections_accepted,
        "connectionsActive": status.connections_active,
        "streamsAccepted": status.streams_accepted,
        "streamsRejected": status.streams_rejected,
        "lastPath": status.last_path.map(|snapshot| json!({
            "observedPath": snapshot.observed_path.as_str(),
            "isRelay": snapshot.is_relay,
            "remoteEndpointId": snapshot.remote_endpoint_id,
            "atMs": snapshot.at_ms,
        })),
    })
}

fn machine_acceptor_status_json(status: happier_iroh_core::MachineAcceptorStatus) -> Value {
    json!({
        "running": status.running,
        "connectionsAccepted": status.connections_accepted,
        "connectionsActive": status.connections_active,
        "streamsAccepted": status.streams_accepted,
        "streamsActive": status.streams_active,
        "streamsRejected": status.streams_rejected,
        "lastErrorCode": status.last_failure.map(|failure| failure.as_str()),
        "lastPath": status.last_path.map(|snapshot| json!({
            "observedPath": snapshot.observed_path.as_str(), "isRelay": snapshot.is_relay,
            "remoteEndpointId": snapshot.remote_endpoint_id, "atMs": snapshot.at_ms,
        })),
    })
}

fn get_endpoint_status(value: *const c_char) -> Value {
    let input = match parse_json::<EndpointHandleRequest>(value) {
        Ok(v) => v,
        Err((code, message)) => return error_response(&code, message),
    };
    let Some(identity) = endpoint_identity_for(&input.endpoint_handle) else {
        return json!({"ok": true, "result": Value::Null});
    };
    let Some((config, endpoint)) = state().manager.get(&identity) else {
        return json!({"ok": true, "result": Value::Null});
    };
    let addr = endpoint.endpoint().addr();
    json!({"ok": true, "result": {
        "endpointHandle": input.endpoint_handle,
        "endpointId": endpoint.id().to_string(),
        "relayPolicy": config.relay_policy.as_str(),
        "relayMode": config.relay.mode(),
        "relayUrls": config.relay.relay_urls().iter().map(|url| url.to_string()).collect::<Vec<_>>(),
        "capProfile": config.caps.id(),
        "directAddresses": addr.ip_addrs().map(|socket| socket.to_string()).collect::<Vec<_>>(),
        "active": true,
    }})
}

pub fn get_tunnel_status_json(request: &str) -> Value {
    let input = match serde_json::from_str::<TunnelHandleRequest>(request) {
        Ok(v) => v,
        Err(error) => return error_response("invalid-request", error.to_string()),
    };
    let tunnels = state().tunnels.lock().expect("lease lock poisoned");
    match tunnels.get(&input.tunnel_id) {
        None => json!({"ok": true, "result": Value::Null}),
        Some(lease) => {
            let tunnel_status = lease.tunnel.status();
            let observed_path = tunnel_status
                .observed_path
                .as_ref()
                .map(|snapshot| snapshot.observed_path.as_str())
                .unwrap_or("unknown");
            #[cfg(feature = "test-relay-fixture")]
            record_test_observed_path(observed_path);
            json!({"ok": true, "result": {
                "tunnelId": input.tunnel_id,
                "homeServerIdentityId": lease.home_server_identity_id,
                "runtimeOrigin": lease.runtime_origin,
                "carrier": "iroh",
                "observedPath": observed_path,
                "connectionActive": tunnel_status.connection_active,
                "streamsOpened": tunnel_status.streams_opened,
                "startedAtMs": lease.started_at_ms,
                "endpointHandle": lease.endpoint_handle,
            }})
        }
    }
}

fn get_tunnel_status(value: *const c_char) -> Value {
    match c_request_string(value) {
        Ok(request) => get_tunnel_status_json(&request),
        Err((code, message)) => error_response(code, message),
    }
}

// ---------------------------------------------------------------------------
// C ABI
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn happier_iroh_native_create_endpoint_json(value: *const c_char) -> *mut c_char {
    response(create_endpoint(value))
}
#[no_mangle]
pub extern "C" fn happier_iroh_native_start_home_acceptor_json(
    value: *const c_char,
) -> *mut c_char {
    response(start_home_acceptor(value))
}
#[no_mangle]
pub extern "C" fn happier_iroh_native_stop_home_acceptor_json(value: *const c_char) -> *mut c_char {
    response(stop_home_acceptor(value))
}
#[no_mangle]
pub extern "C" fn happier_iroh_native_ensure_home_tunnel_json(value: *const c_char) -> *mut c_char {
    response(ensure_home_tunnel(value))
}
#[no_mangle]
pub extern "C" fn happier_iroh_native_release_home_tunnel_json(
    value: *const c_char,
) -> *mut c_char {
    response(release_home_tunnel(value))
}
#[no_mangle]
pub extern "C" fn happier_iroh_native_shutdown_endpoint_json(value: *const c_char) -> *mut c_char {
    response(shutdown_endpoint(value))
}
#[no_mangle]
pub extern "C" fn happier_iroh_native_get_endpoint_status_json(
    value: *const c_char,
) -> *mut c_char {
    response(get_endpoint_status(value))
}
#[no_mangle]
pub extern "C" fn happier_iroh_native_get_tunnel_status_json(value: *const c_char) -> *mut c_char {
    response(get_tunnel_status(value))
}

#[cfg(feature = "test-relay-fixture")]
#[no_mangle]
pub extern "C" fn happier_iroh_native_test_force_direct_only_json(
    _value: *const c_char,
) -> *mut c_char {
    response(force_direct_only_for_tests())
}

#[cfg(feature = "test-relay-fixture")]
#[no_mangle]
pub extern "C" fn happier_iroh_native_test_force_relay_only_json(
    value: *const c_char,
) -> *mut c_char {
    response(force_relay_only_for_tests(value))
}

#[cfg(feature = "test-relay-fixture")]
#[no_mangle]
pub extern "C" fn happier_iroh_native_test_restore_automatic_json(
    _value: *const c_char,
) -> *mut c_char {
    response(restore_automatic_for_tests())
}

/// Synchronous observed-path read for the test-only controller. This symbol
/// does not exist unless the non-release `test-relay-fixture` feature is set.
#[cfg(feature = "test-relay-fixture")]
pub fn happier_iroh_native_test_observed_path() -> &'static str {
    test_observed_path()
}

/// Fixture relay hint for explicit test-environment descriptor wiring. The
/// production server continues publishing only its configured relay URLs.
#[cfg(feature = "test-relay-fixture")]
pub fn happier_iroh_native_test_relay_url() -> Option<String> {
    test_relay_url()
}

#[no_mangle]
pub extern "C" fn happier_iroh_native_start_machine_acceptor_json(
    value: *const c_char,
) -> *mut c_char {
    response(start_machine_acceptor(value))
}
#[no_mangle]
pub extern "C" fn happier_iroh_native_stop_machine_acceptor_json(
    value: *const c_char,
) -> *mut c_char {
    response(stop_machine_acceptor(value))
}
#[no_mangle]
pub extern "C" fn happier_iroh_native_get_machine_acceptor_status_json(
    value: *const c_char,
) -> *mut c_char {
    response(get_machine_acceptor_status(value))
}
#[no_mangle]
pub extern "C" fn happier_iroh_native_start_machine_tunnel_json(
    value: *const c_char,
) -> *mut c_char {
    response(start_machine_tunnel(value))
}
#[no_mangle]
pub extern "C" fn happier_iroh_native_start_machine_http_tunnel_json(
    value: *const c_char,
) -> *mut c_char {
    response(start_machine_http_tunnel(value))
}
#[no_mangle]
pub extern "C" fn happier_iroh_native_stop_machine_tunnel_json(
    value: *const c_char,
) -> *mut c_char {
    response(stop_machine_tunnel(value))
}
#[no_mangle]
pub extern "C" fn happier_iroh_native_wait_machine_tunnel_closed_json(
    value: *const c_char,
) -> *mut c_char {
    response(wait_machine_tunnel_closed(value))
}
#[no_mangle]
pub extern "C" fn happier_iroh_native_get_machine_tunnel_status_json(
    value: *const c_char,
) -> *mut c_char {
    response(get_machine_tunnel_status(value))
}

#[no_mangle]
pub extern "C" fn happier_iroh_native_free_string(value: *mut c_char) {
    if !value.is_null() {
        unsafe {
            drop(CString::from_raw(value));
        }
    }
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use jni::{
        objects::{GlobalRef, JClass, JObject, JString},
        sys::jstring,
        JNIEnv,
    };
    use std::sync::Mutex;

    // `ndk_context` retains this raw jobject for the process lifetime. Keep a
    // JNI global reference alive so Android cannot collect the application
    // context after this boundary call returns.
    static ANDROID_APPLICATION_CONTEXT: Mutex<Option<GlobalRef>> = Mutex::new(None);

    #[no_mangle]
    pub extern "system" fn Java_dev_happier_iroh_HappierIrohNativeRust_installAndroidContext(
        mut env: JNIEnv<'_>,
        _: JClass<'_>,
        application_context: JObject<'_>,
    ) {
        let mut installed = match ANDROID_APPLICATION_CONTEXT.lock() {
            Ok(installed) => installed,
            Err(_) => {
                let _ = env.throw_new(
                    "java/lang/IllegalStateException",
                    "Iroh Android application context initialization failed",
                );
                return;
            }
        };
        if installed.is_some() {
            return;
        }

        let java_vm = match env.get_java_vm() {
            Ok(java_vm) => java_vm,
            Err(_) => {
                let _ = env.throw_new(
                    "java/lang/IllegalStateException",
                    "Iroh could not access the Android Java VM",
                );
                return;
            }
        };
        let application_context = match env.new_global_ref(application_context) {
            Ok(application_context) => application_context,
            Err(_) => {
                let _ = env.throw_new(
                    "java/lang/IllegalStateException",
                    "Iroh could not retain the Android application context",
                );
                return;
            }
        };

        unsafe {
            iroh::dns::install_android_jni_context(
                java_vm.get_java_vm_pointer().cast(),
                application_context.as_obj().as_raw().cast(),
            );
        }
        *installed = Some(application_context);
    }

    fn call(
        env: &mut JNIEnv<'_>,
        input: JString<'_>,
        operation: extern "C" fn(*const c_char) -> *mut c_char,
    ) -> jstring {
        let text = env
            .get_string(&input)
            .map(|v| v.to_string_lossy().into_owned())
            .unwrap_or_default();
        let c = CString::new(text).expect("JNI string has no NUL");
        let out = operation(c.as_ptr());
        if out.is_null() {
            return env.new_string("{\"ok\":false,\"error\":{\"code\":\"engine-internal\",\"message\":\"Native Iroh engine returned no response\"}}").expect("JNI error string").into_raw();
        }
        let result = unsafe { CStr::from_ptr(out) }
            .to_string_lossy()
            .into_owned();
        happier_iroh_native_free_string(out);
        env.new_string(result)
            .expect("JNI result string")
            .into_raw()
    }
    #[no_mangle]
    pub extern "system" fn Java_dev_happier_iroh_HappierIrohNativeRust_ensureHomeTunnelJson(
        mut env: JNIEnv<'_>,
        _: JClass<'_>,
        input: JString<'_>,
    ) -> jstring {
        call(&mut env, input, happier_iroh_native_ensure_home_tunnel_json)
    }
    #[no_mangle]
    pub extern "system" fn Java_dev_happier_iroh_HappierIrohNativeRust_releaseHomeTunnelJson(
        mut env: JNIEnv<'_>,
        _: JClass<'_>,
        input: JString<'_>,
    ) -> jstring {
        call(
            &mut env,
            input,
            happier_iroh_native_release_home_tunnel_json,
        )
    }
    #[no_mangle]
    pub extern "system" fn Java_dev_happier_iroh_HappierIrohNativeRust_shutdownEndpointJson(
        mut env: JNIEnv<'_>,
        _: JClass<'_>,
        input: JString<'_>,
    ) -> jstring {
        call(&mut env, input, happier_iroh_native_shutdown_endpoint_json)
    }
    #[no_mangle]
    pub extern "system" fn Java_dev_happier_iroh_HappierIrohNativeRust_getTunnelStatusJson(
        mut env: JNIEnv<'_>,
        _: JClass<'_>,
        input: JString<'_>,
    ) -> jstring {
        call(&mut env, input, happier_iroh_native_get_tunnel_status_json)
    }
    #[no_mangle]
    pub extern "system" fn Java_dev_happier_iroh_HappierIrohNativeRust_createEndpointJson(
        mut env: JNIEnv<'_>,
        _: JClass<'_>,
        input: JString<'_>,
    ) -> jstring {
        call(&mut env, input, happier_iroh_native_create_endpoint_json)
    }
    #[no_mangle]
    pub extern "system" fn Java_dev_happier_iroh_HappierIrohNativeRust_startMachineTunnelJson(
        mut env: JNIEnv<'_>,
        _: JClass<'_>,
        input: JString<'_>,
    ) -> jstring {
        call(
            &mut env,
            input,
            happier_iroh_native_start_machine_tunnel_json,
        )
    }
    #[no_mangle]
    pub extern "system" fn Java_dev_happier_iroh_HappierIrohNativeRust_startMachineHttpTunnelJson(
        mut env: JNIEnv<'_>,
        _: JClass<'_>,
        input: JString<'_>,
    ) -> jstring {
        call(
            &mut env,
            input,
            happier_iroh_native_start_machine_http_tunnel_json,
        )
    }
    #[no_mangle]
    pub extern "system" fn Java_dev_happier_iroh_HappierIrohNativeRust_stopMachineTunnelJson(
        mut env: JNIEnv<'_>,
        _: JClass<'_>,
        input: JString<'_>,
    ) -> jstring {
        call(
            &mut env,
            input,
            happier_iroh_native_stop_machine_tunnel_json,
        )
    }
    #[no_mangle]
    pub extern "system" fn Java_dev_happier_iroh_HappierIrohNativeRust_waitMachineTunnelClosedJson(
        mut env: JNIEnv<'_>,
        _: JClass<'_>,
        input: JString<'_>,
    ) -> jstring {
        call(&mut env, input, happier_iroh_native_wait_machine_tunnel_closed_json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_dispatch_uses_one_autonomous_network_worker() {
        let (completed_tx, completed_rx) = std::sync::mpsc::channel();
        spawn_lifecycle_operation(move || {
            runtime().spawn(async move {
                tokio::task::yield_now().await;
                completed_tx
                    .send(runtime().metrics().num_workers())
                    .expect("report worker count after lifecycle dispatch returns");
            });
        });
        let workers = completed_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("network work progresses without an active host lifecycle call");
        assert_eq!(
            workers, 1,
            "Iroh needs one network event loop, not host-core workers"
        );
    }

    #[test]
    fn endpoint_lifecycle_closes_admission_and_waits_for_admitted_work() {
        let lifecycle = Arc::new(EndpointLifecycle::new());
        let admitted = lifecycle
            .try_admit()
            .expect("active endpoint admits lifecycle work");

        lifecycle.begin_shutdown();
        assert!(
            lifecycle.try_admit().is_none(),
            "shutdown must synchronously refuse later endpoint work"
        );
        assert!(admitted.is_cancelled(), "admitted work observes shutdown");

        let (settled_tx, settled_rx) = std::sync::mpsc::channel();
        let waiting_lifecycle = Arc::clone(&lifecycle);
        let waiter = std::thread::spawn(move || {
            waiting_lifecycle.wait_for_admitted();
            settled_tx.send(()).expect("report settled admission");
        });
        assert!(
            settled_rx
                .recv_timeout(std::time::Duration::from_millis(25))
                .is_err(),
            "shutdown cannot complete while admitted work still owns custody"
        );

        drop(admitted);
        settled_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("shutdown settles after admitted work releases custody");
        waiter.join().expect("lifecycle waiter joins");
    }

    #[test]
    fn endpoint_shutdown_refuses_concurrent_recreate_and_allows_clean_restart() {
        let key = temp_key_path("shutdown-admission");
        let (handle, _, _) = create_disabled_endpoint(&key);
        let lifecycle = state()
            .endpoint_handles
            .lock()
            .expect("endpoint handle lock")
            .get(&handle)
            .map(|entry| Arc::clone(&entry.lifecycle))
            .expect("created endpoint lifecycle");
        let admitted = lifecycle.try_admit().expect("hold admitted work");

        let shutdown_handle = handle.clone();
        let shutdown = std::thread::spawn(move || {
            shutdown_endpoint_json(&json!({ "endpointHandle": shutdown_handle }).to_string())
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !admitted.is_cancelled() && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert!(admitted.is_cancelled(), "shutdown closes admission first");

        let rejected = create_endpoint_json(
            &json!({ "keyPath": &key, "relayPolicy": "disabled" }).to_string(),
        );
        assert_eq!(rejected["ok"], false, "concurrent recreate: {rejected}");
        assert_eq!(rejected["error"]["code"], "cancelled");

        drop(admitted);
        let stopped = shutdown.join().expect("shutdown thread joins");
        assert_eq!(stopped["ok"], true, "shutdown result: {stopped}");
        assert!(endpoint_identity_for(&handle).is_none());

        let restarted = create_endpoint_json(
            &json!({ "keyPath": &key, "relayPolicy": "disabled" }).to_string(),
        );
        assert_eq!(restarted["ok"], true, "clean restart: {restarted}");
        let restarted_handle = restarted["result"]["endpointHandle"]
            .as_str()
            .expect("restarted handle");
        let _ = shutdown_endpoint_json(&json!({ "endpointHandle": restarted_handle }).to_string());
        remove_temp_key(&key);
    }

    #[test]
    fn endpoint_shutdown_admission_can_close_before_blocking_cleanup_is_scheduled() {
        let key = temp_key_path("shutdown-preclose");
        let (handle, _, _) = create_disabled_endpoint(&key);
        let request = json!({ "endpointHandle": handle }).to_string();

        let closed = begin_endpoint_shutdown_json(&request);
        assert_eq!(closed["ok"], true, "pre-close result: {closed}");
        assert_eq!(
            closed["result"]["found"], true,
            "pre-close result: {closed}"
        );

        let lifecycle = state()
            .endpoint_handles
            .lock()
            .expect("endpoint handle lock")
            .get(&handle)
            .map(|entry| Arc::clone(&entry.lifecycle))
            .expect("pre-close retains the handle for aggregate cleanup");
        assert!(
            lifecycle.try_admit().is_none(),
            "the host-call boundary closes admission before queued cleanup can run"
        );

        let stopped = shutdown_endpoint_json(&request);
        assert_eq!(stopped["ok"], true, "shutdown result: {stopped}");
        let _ = std::fs::remove_file(key);
    }

    #[test]
    fn endpoint_shutdown_cancels_an_admitted_home_connect_without_publishing_a_lease() {
        let remote_key = temp_key_path("shutdown-remote");
        let (remote_handle, remote_endpoint_id, _) = create_disabled_endpoint(&remote_key);
        let _ = shutdown_endpoint_json(&json!({ "endpointHandle": remote_handle }).to_string());

        let client_key = temp_key_path("shutdown-client");
        let (client_handle, _, _) = create_disabled_endpoint(&client_key);
        let lifecycle = state()
            .endpoint_handles
            .lock()
            .expect("endpoint handle lock")
            .get(&client_handle)
            .map(|entry| Arc::clone(&entry.lifecycle))
            .expect("client lifecycle");
        let start_handle = client_handle.clone();
        let start = std::thread::spawn(move || {
            ensure_home_tunnel_json(
                &json!({
                    "endpointHandle": start_handle,
                    "homeServerIdentityId": "srv_shutdown_race",
                    "endpointId": remote_endpoint_id,
                    "directAddresses": ["127.0.0.1:9"],
                    "relayUrls": []
                })
                .to_string(),
            )
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while lifecycle.admitted_count() == 0 && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(lifecycle.admitted_count(), 1, "Home connect was admitted");

        let stopped =
            shutdown_endpoint_json(&json!({ "endpointHandle": client_handle }).to_string());
        assert_eq!(stopped["ok"], true, "shutdown result: {stopped}");
        let start_result = start.join().expect("Home start thread joins");
        assert_eq!(start_result["ok"], false, "late Home start: {start_result}");
        assert!(
            matches!(
                start_result["error"]["code"].as_str(),
                Some("cancelled" | "transport_closed")
            ),
            "shutdown may win through the admission signal or by closing the owned endpoint: {start_result}"
        );
        assert!(
            state()
                .tunnels
                .lock()
                .expect("lease lock")
                .values()
                .all(|lease| lease.endpoint_handle != client_handle),
            "cancelled Home start must not publish a late lease"
        );
        remove_temp_key(&remote_key);
        remove_temp_key(&client_key);
    }

    #[test]
    fn same_endpoint_broker_http_uses_current_admission_and_fresh_authority() {
        use std::io::{Read, Write};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let key = temp_key_path("same-endpoint-broker");
        let (handle, endpoint_id, _) = create_disabled_endpoint(&key);
        let request_json = json!({ "endpointHandle": handle, "endpointId": endpoint_id,
            "handshakeJson": "{\"v\":1,\"kind\":\"provider_broker\"}", "capProfile": "machineBulk" }).to_string();
        let absent = start_machine_http_tunnel_json(&request_json);
        assert_eq!(absent["error"]["code"], "transport-unavailable", "self open needs the active acceptor");
        let app = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let app_port = app.local_addr().unwrap().port();
        let app_task = std::thread::spawn(move || {
            let (mut socket, _) = app.accept().unwrap();
            let mut capability = [0; 64];
            socket.read_exact(&mut capability).unwrap();
            assert_eq!(capability, [b'e'; 64]);
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            assert!(!String::from_utf8_lossy(&request).contains("X-Happier-Machine-Local-Capability"));
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nanswer").unwrap();
        });
        let admission = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let admission_port = admission.local_addr().unwrap().port();
        let expected_endpoint = endpoint_id.clone();
        let admission_task = std::thread::spawn(move || {
            let (mut socket, _) = admission.accept().unwrap();
            let mut head = Vec::new();
            let mut byte = [0];
            while !head.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                head.push(byte[0]);
            }
            let head = String::from_utf8(head).unwrap();
            assert!(head.contains(&format!("X-Happier-Iroh-Remote-Endpoint-Id: {expected_endpoint}")));
            let length: usize = head.lines().find_map(|line| line.strip_prefix("Content-Length: ")).unwrap().parse().unwrap();
            let mut body = vec![0; length];
            socket.read_exact(&mut body).unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["witness"], 1);
            write!(socket, "HTTP/1.1 204 No Content\r\nX-Happier-Iroh-Remote-Endpoint-Id: {expected_endpoint}\r\nX-Happier-Iroh-Application-Port: {app_port}\r\nX-Happier-Iroh-Application-Capability: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", "e".repeat(64)).unwrap();
        });
        let accepted = call_op(json!({ "endpointHandle": handle, "admissionHost": "127.0.0.1", "admissionPort": admission_port }).to_string(), happier_iroh_native_start_machine_acceptor_json);
        assert_eq!(accepted["ok"], true, "{accepted}");
        let witnesses = Arc::new(AtomicUsize::new(0));
        let provider: MachineHandshakeProvider = Arc::new({
            let witnesses = Arc::clone(&witnesses);
            move || {
                let witness = witnesses.fetch_add(1, Ordering::SeqCst) + 1;
                Box::pin(async move { Ok(if witness == 1 {
                    json!({"v":1,"kind":"provider_broker","witness":witness}).to_string()
                } else {
                    json!({"kind":"http_refusal","responseBody":"{\"error\":{\"code\":\"resource_forbidden\"}}"}).to_string()
                }) })
            }
        });
        let opened = start_machine_http_tunnel_with_handshake_provider_json(&json!({
            "endpointHandle": handle, "endpointId": endpoint_id,
            "handshakeJson": "{\"v\":1,\"kind\":\"provider_broker\"}", "capProfile": "machineBulk"
        }).to_string(), provider);
        assert_eq!(opened["ok"], true, "same endpoint must use the active admission owner: {opened}");
        let port = opened["result"]["localPort"].as_u64().unwrap();
        let capability = opened["result"]["localCapability"].as_str().unwrap();
        let request = |capability: &str| {
            let mut socket = std::net::TcpStream::connect(("127.0.0.1", port as u16)).unwrap();
            socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            write!(socket, "GET / HTTP/1.1\r\nHost: localhost\r\nX-Happier-Machine-Local-Capability: {capability}\r\nConnection: close\r\n\r\n").unwrap();
            socket.shutdown(std::net::Shutdown::Write).unwrap();
            let mut response = String::new();
            socket.read_to_string(&mut response).unwrap();
            response
        };
        assert!(request(&"0".repeat(64)).is_empty());
        assert_eq!(witnesses.load(Ordering::SeqCst), 0, "an unauthenticated local request performs no Home work");
        assert!(request(capability).ends_with("answer"));
        assert!(request(capability).contains("resource_forbidden"));
        assert_eq!(witnesses.load(Ordering::SeqCst), 2, "one fresh admission per application connection, no retry");
        app_task.join().unwrap();
        admission_task.join().unwrap();
        let stopped = shutdown_endpoint_json(&json!({"endpointHandle":handle}).to_string());
        assert_eq!(stopped["ok"], true);
        assert!(std::net::TcpStream::connect(("127.0.0.1", port as u16)).is_err());
        remove_temp_key(&key);
    }

    #[test]
    fn machine_tunnel_identity_mismatch_surfaces_the_existing_failure_code() {
        let response = machine_start_error(happier_iroh_core::IrohError::EndpointIdentityMismatch);
        assert_eq!(
            response["error"]["code"],
            happier_iroh_core::MachineFailureCode::EndpointIdentityMismatch.as_str()
        );
    }

    #[test]
    fn optional_machine_local_capability_is_omitted_for_raw_finite_transfer() {
        let mut result = json!({"localPort": 43123});
        add_optional_local_capability(&mut result, None);
        assert!(
            result.get("localCapability").is_none(),
            "raw finite-transfer results must not publish a local capability field"
        );
        add_optional_local_capability(&mut result, Some("qualified-capability".to_owned()));
        assert_eq!(result["localCapability"], "qualified-capability");
    }

    #[test]
    fn home_dial_without_addressing_reports_unreachable_before_acquisition() {
        let remote_key = temp_key_path("no-hints-remote");
        let (remote_handle, remote_endpoint_id, _) = create_disabled_endpoint(&remote_key);
        let client_key = temp_key_path("no-hints-client");
        let (client_handle, _, _) = create_disabled_endpoint(&client_key);
        let result = ensure_home_tunnel_json(&json!({
            "endpointHandle": client_handle,
            "homeServerIdentityId": "srv_no_hints",
            "endpointId": remote_endpoint_id
        }).to_string());
        let _ = shutdown_endpoint_json(&json!({ "endpointHandle": client_handle }).to_string());
        let _ = shutdown_endpoint_json(&json!({ "endpointHandle": remote_handle }).to_string());
        remove_temp_key(&client_key);
        remove_temp_key(&remote_key);
        assert_eq!(result["error"]["code"], "home_unreachable", "{result}");
    }

    #[test]
    fn home_tunnel_failures_keep_their_native_category() {
        let cases = [
            (
                happier_iroh_core::IrohError::InvalidDescriptor,
                "invalid_descriptor",
            ),
            (
                happier_iroh_core::IrohError::UnsupportedAlpn,
                "unsupported_alpn",
            ),
            (
                happier_iroh_core::IrohError::InvalidPreamble,
                "invalid_preamble",
            ),
            (
                happier_iroh_core::IrohError::EndpointConfigConflict,
                "endpoint_config_conflict",
            ),
            (
                happier_iroh_core::IrohError::ResourceLimit,
                "resource_limit",
            ),
            (
                happier_iroh_core::IrohError::LoopbackBindFailed,
                "loopback_bind_failed",
            ),
            (
                happier_iroh_core::IrohError::TransportTimeout,
                "transport_timeout",
            ),
            (
                happier_iroh_core::IrohError::TransportClosed,
                "transport_closed",
            ),
        ];

        for (error, expected_code) in cases {
            let response = tunnel_start_error(error);
            assert_eq!(response["error"]["code"], expected_code);
        }
    }

    fn read(value: *mut c_char) -> Value {
        let raw = unsafe { CStr::from_ptr(value) }
            .to_string_lossy()
            .into_owned();
        happier_iroh_native_free_string(value);
        serde_json::from_str(&raw).expect("valid JSON response")
    }

    /// Calls a JSON op with a request payload and reads the response.
    fn call_op(payload: String, op: extern "C" fn(*const c_char) -> *mut c_char) -> Value {
        let request = CString::new(payload).expect("test JSON has no NUL");
        read(op(request.as_ptr()))
    }

    fn temp_key_path(label: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "happier-iroh-native-{}-{}-{}",
                label,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
            .join("endpoint.key")
            .to_string_lossy()
            .replace('\\', "/")
    }

    fn remove_temp_key(path: &str) {
        let path = Path::new(path);
        let _ = std::fs::remove_file(path);
        if let Some(parent) = path.parent() {
            let _ = std::fs::remove_dir(parent);
        }
    }

    /// Spawns a TCP echo server on the shared tokio runtime and returns its
    /// loopback address: the acceptor's fixed loopback target.
    fn spawn_echo_target() -> SocketAddr {
        runtime().block_on(async {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    tokio::spawn(async move {
                        let mut buffer = [0u8; 1024];
                        loop {
                            match socket.read(&mut buffer).await {
                                Ok(0) | Err(_) => break,
                                Ok(n) => {
                                    if socket.write_all(&buffer[..n]).await.is_err() {
                                        break;
                                    }
                                }
                            }
                        }
                    });
                }
            });
            addr
        })
    }

    fn create_disabled_endpoint(key_path: &str) -> (String, String, String) {
        let created = call_op(
            format!(r#"{{"keyPath":"{key_path}","relayPolicy":"disabled"}}"#),
            happier_iroh_native_create_endpoint_json,
        );
        assert_eq!(created["ok"], true, "endpoint create: {created}");
        let handle = created["result"]["endpointHandle"]
            .as_str()
            .unwrap()
            .to_owned();
        let status = call_op(
            format!(r#"{{"endpointHandle":"{handle}"}}"#),
            happier_iroh_native_get_endpoint_status_json,
        );
        let endpoint_id = status["result"]["endpointId"].as_str().unwrap().to_owned();
        let direct_address = status["result"]["directAddresses"]
            .as_array()
            .and_then(|addrs| addrs.first())
            .and_then(|value| value.as_str())
            .expect("endpoint status publishes a direct address")
            .to_owned();
        (handle, endpoint_id, direct_address)
    }

    fn ensure_tunnel(
        client_handle: &str,
        identity: &str,
        server_endpoint_id: &str,
        direct_address: &str,
    ) -> Value {
        call_op(
            format!(
                r#"{{"endpointHandle":"{client_handle}","homeServerIdentityId":"{identity}","endpointId":"{server_endpoint_id}","directAddresses":["{direct_address}"]}}"#
            ),
            happier_iroh_native_ensure_home_tunnel_json,
        )
    }

    /// Parses a lease's published HTTP runtime origin into the concrete
    /// loopback socket address the fixture dials. Strictly `http://` +
    /// IP-literal + port, loopback only: the fixture never resolves or dials
    /// an arbitrary destination while still proving the runtimeOrigin HTTP
    /// contract.
    fn loopback_target_of_origin(origin: &str) -> SocketAddr {
        let host_port = origin
            .strip_prefix("http://")
            .expect("runtime origin must be an http:// URL");
        let addr: SocketAddr = host_port
            .parse()
            .expect("runtime origin host must be an IP-literal socket address");
        assert!(
            addr.ip().is_loopback(),
            "runtime origin must stay loopback-only"
        );
        addr
    }

    fn echo_over(origin: &str, payload: &[u8]) {
        runtime().block_on(async {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut socket = tokio::net::TcpStream::connect(loopback_target_of_origin(origin))
                .await
                .unwrap();
            socket.write_all(payload).await.unwrap();
            let mut echo = vec![0u8; payload.len()];
            socket.read_exact(&mut echo).await.unwrap();
            assert_eq!(echo, payload);
        });
    }

    #[test]
    fn corrupt_endpoint_key_fails_closed_without_silent_rotation() {
        let path = std::env::temp_dir().join(format!(
            "happier-iroh-native-corrupt-key-{}.key",
            std::process::id()
        ));
        std::fs::write(&path, vec![0u8; 16]).expect("write corrupt key");
        let corrupt = std::fs::read(&path).expect("read corrupt key");
        // Forward slashes keep the JSON valid on Windows as well as POSIX hosts.
        let portable_path = path.to_string_lossy().replace('\\', "/");
        let response = call_op(
            format!(
                r#"{{"relayPolicy":"automatic","keyPath":"{}"}}"#,
                portable_path,
            ),
            happier_iroh_native_create_endpoint_json,
        );
        assert_eq!(response["ok"], false);
        assert_eq!(
            response["error"]["code"],
            Value::String("endpoint_key_unavailable".to_owned())
        );
        // Fail closed: the corrupt identity bytes are left untouched, never regenerated.
        assert_eq!(std::fs::read(&path).expect("reread corrupt key"), corrupt);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn native_only_endpoint_seed_is_strict_and_mutually_exclusive_with_key_path() {
        let base = |seed: &str, extra: &str| {
            format!(r#"{{"relayPolicy":"automatic","endpointSeedBase64":"{seed}"{extra}}}"#,)
        };
        for seed in [
            "",
            "not-base64!",
            "AQ==",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        ] {
            let response = call_op(base(seed, ""), happier_iroh_native_create_endpoint_json);
            assert_eq!(response["ok"], false, "seed {seed:?}: {response}");
            assert_eq!(response["error"]["code"], "invalid-request");
            if !seed.is_empty() {
                assert!(
                    !response.to_string().contains(seed),
                    "secret input leaked in response"
                );
            }
        }

        let valid_seed = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
        let response = call_op(
            base(valid_seed, r#", "keyPath":"/tmp/iroh.key""#),
            happier_iroh_native_create_endpoint_json,
        );
        assert_eq!(response["ok"], false, "conflict: {response}");
        assert_eq!(response["error"]["code"], "invalid-request");
        assert!(!response.to_string().contains(valid_seed));
    }

    /// Full JSON-lifecycle vertical: real endpoints, real acceptor, real
    /// tunnel leases, real loopback bytes — through the exact ops the desktop
    /// composition wave consumes.
    #[test]
    fn json_lifecycle_moves_bytes_over_one_shared_process_endpoint() {
        let server_key = temp_key_path("server");
        let client_key = temp_key_path("client");
        let target = spawn_echo_target();

        let (server_handle, server_endpoint_id, direct_address) =
            create_disabled_endpoint(&server_key);
        let acceptor = call_op(
            format!(
                r#"{{"endpointHandle":"{server_handle}","targetPort":{}}}"#,
                target.port()
            ),
            happier_iroh_native_start_home_acceptor_json,
        );
        assert_eq!(acceptor["ok"], true, "acceptor start: {acceptor}");
        assert_eq!(acceptor["result"]["reused"], false);

        let (client_handle, _, _) = create_disabled_endpoint(&client_key);

        let first = ensure_tunnel(
            &client_handle,
            "srv_home_a",
            &server_endpoint_id,
            &direct_address,
        );
        assert_eq!(first["ok"], true, "first tunnel: {first}");
        let second = ensure_tunnel(
            &client_handle,
            "srv_home_b",
            &server_endpoint_id,
            &direct_address,
        );
        assert_eq!(second["ok"], true, "second tunnel: {second}");
        assert_eq!(
            first["result"]["endpointHandle"], client_handle,
            "compatible leases must share the endpoint handle"
        );

        // Both leases move real bytes over the one shared client endpoint.
        for origin in [
            first["result"]["runtimeOrigin"].as_str().unwrap(),
            second["result"]["runtimeOrigin"].as_str().unwrap(),
        ] {
            echo_over(origin, b"json-lifecycle-bytes");
        }

        // The acceptor saw exactly one Iroh connection carrying two streams.
        let acceptor_status = call_op(
            format!(
                r#"{{"endpointHandle":"{server_handle}","targetPort":{}}}"#,
                target.port()
            ),
            happier_iroh_native_start_home_acceptor_json,
        );
        assert_eq!(acceptor_status["result"]["reused"], true);
        // Two leases = two lease-scoped Iroh connections on the shared client
        // endpoint, each carrying one local stream.
        assert_eq!(
            acceptor_status["result"]["status"]["connectionsAccepted"],
            2
        );
        assert_eq!(acceptor_status["result"]["status"]["streamsAccepted"], 2);

        // Honest direct-path telemetry on the tunnel lease.
        let tunnel_status = call_op(
            format!(
                r#"{{"tunnelId":"{}"}}"#,
                first["result"]["tunnelId"].as_str().unwrap()
            ),
            happier_iroh_native_get_tunnel_status_json,
        );
        assert_eq!(tunnel_status["result"]["observedPath"], "direct");
        assert_eq!(tunnel_status["result"]["connectionActive"], true);

        // First-use key provisioning with restrictive POSIX permissions.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&client_key).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "first-provisioned keys stay 0600");
        }

        call_op(
            format!(r#"{{"endpointHandle":"{client_handle}"}}"#),
            happier_iroh_native_shutdown_endpoint_json,
        );
        call_op(
            format!(r#"{{"endpointHandle":"{server_handle}"}}"#),
            happier_iroh_native_shutdown_endpoint_json,
        );
        remove_temp_key(&server_key);
        remove_temp_key(&client_key);
    }

    #[test]
    fn releasing_one_lease_keeps_shared_endpoint_and_sibling_lease() {
        let server_key = temp_key_path("server");
        let client_key = temp_key_path("client");
        let target = spawn_echo_target();

        let (server_handle, server_endpoint_id, direct_address) =
            create_disabled_endpoint(&server_key);
        call_op(
            format!(
                r#"{{"endpointHandle":"{server_handle}","targetPort":{}}}"#,
                target.port()
            ),
            happier_iroh_native_start_home_acceptor_json,
        );
        let (client_handle, _, _) = create_disabled_endpoint(&client_key);

        let first = ensure_tunnel(
            &client_handle,
            "srv_home_a",
            &server_endpoint_id,
            &direct_address,
        );
        let second = ensure_tunnel(
            &client_handle,
            "srv_home_b",
            &server_endpoint_id,
            &direct_address,
        );
        assert_eq!(first["ok"], true);
        assert_eq!(second["ok"], true);
        let first_origin = first["result"]["runtimeOrigin"]
            .as_str()
            .unwrap()
            .to_owned();
        let first_tunnel_id = first["result"]["tunnelId"].as_str().unwrap().to_owned();

        // Release the first lease only; release is lease-scoped and idempotent.
        let release = call_op(
            format!(r#"{{"tunnelId":"{first_tunnel_id}"}}"#),
            happier_iroh_native_release_home_tunnel_json,
        );
        assert_eq!(release["ok"], true);
        // The released lease stops serving its origin.
        let released_down = runtime().block_on(async {
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                tokio::net::TcpStream::connect(loopback_target_of_origin(&first_origin)),
            )
            .await
            .map(|outcome| outcome.is_err())
            .unwrap_or(true)
        });
        assert!(released_down, "released lease must stop serving its origin");

        // The sibling lease and the shared endpoint remain healthy.
        let sibling_status = call_op(
            format!(
                r#"{{"tunnelId":"{}"}}"#,
                second["result"]["tunnelId"].as_str().unwrap()
            ),
            happier_iroh_native_get_tunnel_status_json,
        );
        assert_eq!(sibling_status["result"]["connectionActive"], true);
        let endpoint_status = call_op(
            format!(r#"{{"endpointHandle":"{client_handle}"}}"#),
            happier_iroh_native_get_endpoint_status_json,
        );
        assert_eq!(endpoint_status["result"]["active"], true);

        call_op(
            format!(r#"{{"endpointHandle":"{client_handle}"}}"#),
            happier_iroh_native_shutdown_endpoint_json,
        );
        call_op(
            format!(r#"{{"endpointHandle":"{server_handle}"}}"#),
            happier_iroh_native_shutdown_endpoint_json,
        );
        remove_temp_key(&server_key);
        remove_temp_key(&client_key);
    }

    #[test]
    fn incompatible_endpoint_configs_fail_clearly_without_a_second_owner() {
        let key = temp_key_path("conflict");
        let original = call_op(
            format!(
                r#"{{"keyPath":"{key}","relayPolicy":"automatic","relayUrls":["https://relay.example.test"]}}"#
            ),
            happier_iroh_native_create_endpoint_json,
        );
        assert_eq!(original["ok"], true, "{original}");
        let handle = original["result"]["endpointHandle"]
            .as_str()
            .unwrap()
            .to_owned();

        // Same automatic policy, another Home relay, and another outgoing
        // flow profile reuse the endpoint and extend its applied relay set.
        let expanded = call_op(
            format!(
                r#"{{"keyPath":"{key}","relayPolicy":"automatic","relayUrls":["https://relay-b.example.test"],"capProfile":"machineBulk"}}"#
            ),
            happier_iroh_native_create_endpoint_json,
        );
        assert_eq!(expanded["ok"], true, "{expanded}");
        assert_eq!(expanded["result"]["endpointHandle"], handle);
        assert_eq!(expanded["result"]["relayPolicy"], "automatic");
        assert_eq!(expanded["result"]["relayUrls"].as_array().unwrap().len(), 2);

        // Same key path, different application-wide relay policy: typed
        // conflict rather than silently changing transport policy.
        let conflicting = call_op(
            format!(r#"{{"keyPath":"{key}","relayPolicy":"disabled"}}"#),
            happier_iroh_native_create_endpoint_json,
        );
        assert_eq!(conflicting["ok"], false, "{conflicting}");
        assert_eq!(
            conflicting["error"]["code"],
            Value::String("endpoint_config_conflict".to_owned())
        );

        // The original shared endpoint keeps serving.
        let status = call_op(
            format!(r#"{{"endpointHandle":"{handle}"}}"#),
            happier_iroh_native_get_endpoint_status_json,
        );
        assert_eq!(status["result"]["relayPolicy"], "automatic");
        assert_eq!(status["result"]["relayMode"], "custom");
        assert_eq!(status["result"]["relayUrls"].as_array().unwrap().len(), 2);
        assert_eq!(status["result"]["active"], true);

        call_op(
            format!(r#"{{"endpointHandle":"{handle}"}}"#),
            happier_iroh_native_shutdown_endpoint_json,
        );
        remove_temp_key(&key);
    }
}
