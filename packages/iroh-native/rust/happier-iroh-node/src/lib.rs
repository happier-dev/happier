//! Node/Bun lifecycle-only NAPI binding over the existing
//! `happier-iroh-native` public JSON C ABI.
//!
//! This crate owns no Iroh state and no lifecycle logic. Every operation
//! forwards one C string to the exact `happier_iroh_native_*_json` export and
//! frees the returned string with the existing `happier_iroh_native_free_string`.
//! The `happier-iroh-native` rlib is linked into this cdylib, so its exported
//! symbols — and the one `OnceLock` tokio runtime, `NativeRuntime`,
//! `EndpointManager`, acceptor set, and tunnel-lease map behind them — remain
//! the single process owner this binding shares with every other host surface.
//!
//! Status/metadata only: requests and responses are JSON strings; no tunnel
//! payload bytes cross this boundary, and there is no generic dispatch (one
//! typed export per C ABI operation). Request/response JSON validation and
//! typing live in the TypeScript module (`src/nodeNative.ts`).
//!
//! The synchronous C ABI runs on the existing native runtime's blocking pool.
//! Pending network operations must not occupy libuv's filesystem/DNS workers:
//! those workers also serve daemon logging, heartbeat and request admission.
//! Deferred promises return results on the JS thread without a second runtime.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;

use happier_iroh_native::{MachineHandshakeProvider, MachineHttpObserver};
use happier_iroh_native::{
    begin_endpoint_shutdown_json, happier_iroh_native_create_endpoint_json,
    happier_iroh_native_ensure_home_tunnel_json, happier_iroh_native_free_string,
    happier_iroh_native_get_endpoint_status_json,
    happier_iroh_native_get_machine_acceptor_status_json,
    happier_iroh_native_get_machine_tunnel_status_json, happier_iroh_native_get_tunnel_status_json,
    happier_iroh_native_release_home_tunnel_json, happier_iroh_native_shutdown_endpoint_json,
    happier_iroh_native_start_home_acceptor_json, happier_iroh_native_start_machine_acceptor_json,
    happier_iroh_native_start_machine_http_tunnel_json,
    happier_iroh_native_start_machine_tunnel_json, happier_iroh_native_stop_home_acceptor_json,
    happier_iroh_native_stop_machine_acceptor_json, happier_iroh_native_stop_machine_tunnel_json,
    happier_iroh_native_wait_machine_tunnel_closed_json,
    start_machine_http_tunnel_with_callbacks_json, IrohError,
};
#[cfg(feature = "test-relay-fixture")]
use happier_iroh_native::{
    happier_iroh_native_test_force_direct_only_json,
    happier_iroh_native_test_force_relay_only_json, happier_iroh_native_test_observed_path,
    happier_iroh_native_test_relay_url, happier_iroh_native_test_restore_automatic_json,
};
use napi::bindgen_prelude::{Promise, PromiseRaw};
use napi::threadsafe_function::ThreadsafeFunction;
use napi::{Env, Error, JsValue, Result, Status};
use napi_derive::napi;

type HandshakeProviderFunction = ThreadsafeFunction<(), Promise<String>, (), Status, false>;
type HttpObserverFunction = ThreadsafeFunction<String, Promise<()>, String, Status, false>;

fn start_machine_http_tunnel_operation(
    request: String,
    handshake_provider: Option<std::sync::Arc<HandshakeProviderFunction>>,
    http_observer: Option<std::sync::Arc<HttpObserverFunction>>,
) -> Result<String> {
    if handshake_provider.is_some() || http_observer.is_some() {
        let provider = handshake_provider.map(|callback| {
            let provider: MachineHandshakeProvider = std::sync::Arc::new(move || {
                let callback = std::sync::Arc::clone(&callback);
                Box::pin(async move {
                    let promise = callback
                        .call_async_catch(())
                        .await
                        .map_err(|_| IrohError::Cancelled)?;
                    promise.await.map_err(|_| IrohError::Cancelled)
                })
            });
            provider
        });
        let observer: Option<MachineHttpObserver> = http_observer.map(|callback| {
            std::sync::Arc::new(move |event: String| {
                let callback = std::sync::Arc::clone(&callback);
                Box::pin(async move {
                    if let Ok(promise) = callback.call_async_catch(event).await {
                        let _ = promise.await;
                    }
                }) as std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
            }) as MachineHttpObserver
        });
        return Ok(start_machine_http_tunnel_with_callbacks_json(
            &request,
            provider,
            observer,
        )
        .to_string());
    }
    let request = CString::new(request)
        .map_err(|_| Error::from_reason("Iroh lifecycle request must not contain NUL bytes"))?;
    invoke_json_op(happier_iroh_native_start_machine_http_tunnel_json, &request)
}

fn run_lifecycle_operation(
    env: &Env,
    operation: impl FnOnce() -> Result<String> + Send + 'static,
) -> Result<PromiseRaw<'_, String>> {
    let (deferred, promise) = env.create_deferred::<String, _>()?;
    happier_iroh_native::spawn_lifecycle_operation(move || match operation() {
        Ok(response) => deferred.resolve(move |_| Ok(response)),
        Err(error) => deferred.reject(error),
    });
    Ok(PromiseRaw::new(env.raw(), promise.raw()))
}

/// Release glibc-retained free pages without blocking the JS thread. Other
/// allocators/platforms have no corresponding operation here.
#[napi]
pub fn trim_process_allocator() -> napi::bindgen_prelude::AsyncTask<TrimProcessAllocator> {
    napi::bindgen_prelude::AsyncTask::new(TrimProcessAllocator)
}

// Unlike long network lifecycle waits, this short allocator operation uses
// NAPI's existing worker pool. Standard-only daemons must not initialize the
// CPU-sized Iroh runtime just to release allocator residency.
pub struct TrimProcessAllocator;

impl napi::Task for TrimProcessAllocator {
    type Output = bool;
    type JsValue = bool;

    fn compute(&mut self) -> Result<bool> {
        #[cfg(all(target_os = "linux", target_env = "gnu"))]
        {
            // SAFETY: glibc documents malloc_trim as MT-Safe. Zero retains only
            // the allocator's minimum trailing space; no caller-owned data is freed.
            Ok(unsafe { libc::malloc_trim(0) } != 0)
        }
        #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
        Ok(false)
    }

    fn resolve(&mut self, _env: Env, released: bool) -> Result<bool> {
        Ok(released)
    }
}

fn invoke_json_op(
    operation: extern "C" fn(*const c_char) -> *mut c_char,
    request: &CString,
) -> Result<String> {
    let response = operation(request.as_ptr());
    if response.is_null() {
        return Err(Error::from_reason(
            "happier-iroh-native returned no response for a lifecycle operation",
        ));
    }
    // SAFETY: the C ABI contract returns a NUL-terminated UTF-8 JSON
    // string owned by the caller until `happier_iroh_native_free_string`.
    let raw = unsafe { CStr::from_ptr(response) }
        .to_string_lossy()
        .into_owned();
    happier_iroh_native_free_string(response);
    Ok(raw)
}

fn json_op(
    env: &Env,
    operation: extern "C" fn(*const c_char) -> *mut c_char,
    request: String,
) -> Result<PromiseRaw<'_, String>> {
    let request = CString::new(request)
        .map_err(|_| Error::from_reason("Iroh lifecycle request must not contain NUL bytes"))?;
    run_lifecycle_operation(env, move || invoke_json_op(operation, &request))
}

/// Availability/status metadata for the loaded addon. Synchronous by contract
/// (`NativeIrohModule.getAvailability`); performs no Iroh work.
#[napi(object)]
pub struct IrohNodeAvailability {
    /// Always `true`: the addon only exists when it loaded successfully.
    pub available: bool,
    /// Compile-time target OS of this artifact (for example `macos`).
    pub os: String,
    /// Compile-time target architecture of this artifact.
    pub arch: String,
    /// Engine crate that owns the Iroh runtime behind this binding.
    pub engine: String,
    /// Exact exported lifecycle operation names (the no-payload surface).
    pub surface: Vec<String>,
}

#[napi]
pub fn get_availability() -> IrohNodeAvailability {
    IrohNodeAvailability {
        available: true,
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        engine: "happier-iroh-native".to_owned(),
        surface: [
            "getAvailability",
            "createEndpoint",
            "startHomeAcceptor",
            "stopHomeAcceptor",
            "ensureHomeTunnel",
            "releaseHomeTunnel",
            "shutdownEndpoint",
            "getEndpointStatus",
            "getTunnelStatus",
            "startMachineAcceptor",
            "stopMachineAcceptor",
            "getMachineAcceptorStatus",
            "startMachineTunnel",
            "startMachineHttpTunnel",
            "stopMachineTunnel",
            "getMachineTunnelStatus",
            "waitMachineTunnelClosed",
        ]
        .iter()
        .map(|name| (*name).to_owned())
        .collect(),
    }
}

// These exports exist only in a deliberately feature-built test addon. The
// ordinary/release crate graph cannot name them, so product runtime config
// cannot reach the topology override or the local relay it runs.
#[cfg(feature = "test-relay-fixture")]
#[napi]
pub fn force_direct_only(env: &Env) -> Result<PromiseRaw<'_, String>> {
    json_op(
        env,
        happier_iroh_native_test_force_direct_only_json,
        "{}".to_owned(),
    )
}

#[cfg(feature = "test-relay-fixture")]
#[napi]
pub fn force_relay_only(env: &Env, relay_url: Option<String>) -> Result<PromiseRaw<'_, String>> {
    json_op(
        env,
        happier_iroh_native_test_force_relay_only_json,
        serde_json::json!({ "relayUrl": relay_url }).to_string(),
    )
}

#[cfg(feature = "test-relay-fixture")]
#[napi]
pub fn restore_automatic(env: &Env) -> Result<PromiseRaw<'_, String>> {
    json_op(
        env,
        happier_iroh_native_test_restore_automatic_json,
        "{}".to_owned(),
    )
}

#[cfg(feature = "test-relay-fixture")]
#[napi]
pub fn get_observed_path() -> String {
    happier_iroh_native_test_observed_path().to_owned()
}

#[cfg(feature = "test-relay-fixture")]
#[napi]
pub fn get_test_relay_url() -> Option<String> {
    happier_iroh_native_test_relay_url()
}

// Handle-based lifecycle ops (Lane 06 plan §7.4): one export per C ABI
// operation, JSON request string in, JSON envelope string out. TypeScript
// owns envelope validation and the typed results.

/// Create or reuse the shared process endpoint. Wraps
/// `happier_iroh_native_create_endpoint_json`.
#[napi]
pub fn create_endpoint(env: &Env, request: String) -> Result<PromiseRaw<'_, String>> {
    json_op(env, happier_iroh_native_create_endpoint_json, request)
}

/// Start (or reuse) the fixed-loopback Home acceptor on an endpoint. Wraps
/// `happier_iroh_native_start_home_acceptor_json`.
#[napi]
pub fn start_home_acceptor(env: &Env, request: String) -> Result<PromiseRaw<'_, String>> {
    json_op(env, happier_iroh_native_start_home_acceptor_json, request)
}

/// Stop the endpoint's Home acceptor. Wraps
/// `happier_iroh_native_stop_home_acceptor_json`.
#[napi]
pub fn stop_home_acceptor(env: &Env, request: String) -> Result<PromiseRaw<'_, String>> {
    json_op(env, happier_iroh_native_stop_home_acceptor_json, request)
}

/// Ensure one Home tunnel lease on an endpoint. Wraps
/// `happier_iroh_native_ensure_home_tunnel_json`.
#[napi]
pub fn ensure_home_tunnel(env: &Env, request: String) -> Result<PromiseRaw<'_, String>> {
    json_op(env, happier_iroh_native_ensure_home_tunnel_json, request)
}

/// Release one tunnel lease; sibling leases and the shared endpoint stay up.
/// Wraps `happier_iroh_native_release_home_tunnel_json`.
#[napi]
pub fn release_home_tunnel(env: &Env, request: String) -> Result<PromiseRaw<'_, String>> {
    json_op(env, happier_iroh_native_release_home_tunnel_json, request)
}

/// Shut down an endpoint together with its acceptor and bound leases. Wraps
/// `happier_iroh_native_shutdown_endpoint_json`.
#[napi]
pub fn shutdown_endpoint(env: &Env, request: String) -> Result<PromiseRaw<'_, String>> {
    // Close the canonical native owner's admission on the JavaScript call
    // thread before queuing cleanup, so every already-admitted start observes
    // cancellation before shutdown joins its custody.
    let _ = begin_endpoint_shutdown_json(&request);
    json_op(env, happier_iroh_native_shutdown_endpoint_json, request)
}

/// Endpoint status/metadata. Wraps
/// `happier_iroh_native_get_endpoint_status_json`.
#[napi]
pub fn get_endpoint_status(env: &Env, request: String) -> Result<PromiseRaw<'_, String>> {
    json_op(env, happier_iroh_native_get_endpoint_status_json, request)
}

/// Tunnel lease status/metadata. Wraps
/// `happier_iroh_native_get_tunnel_status_json`.
#[napi]
pub fn get_tunnel_status(env: &Env, request: String) -> Result<PromiseRaw<'_, String>> {
    json_op(env, happier_iroh_native_get_tunnel_status_json, request)
}

#[napi]
pub fn start_machine_acceptor(env: &Env, request: String) -> Result<PromiseRaw<'_, String>> {
    json_op(env, happier_iroh_native_start_machine_acceptor_json, request)
}
#[napi]
pub fn stop_machine_acceptor(env: &Env, request: String) -> Result<PromiseRaw<'_, String>> {
    json_op(env, happier_iroh_native_stop_machine_acceptor_json, request)
}
#[napi]
pub fn get_machine_acceptor_status(env: &Env, request: String) -> Result<PromiseRaw<'_, String>> {
    json_op(
        env,
        happier_iroh_native_get_machine_acceptor_status_json,
        request,
    )
}
#[napi]
pub fn start_machine_tunnel(env: &Env, request: String) -> Result<PromiseRaw<'_, String>> {
    json_op(env, happier_iroh_native_start_machine_tunnel_json, request)
}
#[napi]
pub fn start_machine_http_tunnel(
    env: &Env,
    request: String,
    handshake_provider: Option<std::sync::Arc<HandshakeProviderFunction>>,
    http_observer: Option<std::sync::Arc<HttpObserverFunction>>,
) -> Result<PromiseRaw<'_, String>> {
    run_lifecycle_operation(env, move || {
        start_machine_http_tunnel_operation(request, handshake_provider, http_observer)
    })
}
#[napi]
pub fn stop_machine_tunnel(env: &Env, request: String) -> Result<PromiseRaw<'_, String>> {
    json_op(env, happier_iroh_native_stop_machine_tunnel_json, request)
}
#[napi]
pub fn wait_machine_tunnel_closed(env: &Env, request: String) -> Result<PromiseRaw<'_, String>> {
    json_op(env, happier_iroh_native_wait_machine_tunnel_closed_json, request)
}
#[napi]
pub fn get_machine_tunnel_status(env: &Env, request: String) -> Result<PromiseRaw<'_, String>> {
    json_op(env, happier_iroh_native_get_machine_tunnel_status_json, request)
}
