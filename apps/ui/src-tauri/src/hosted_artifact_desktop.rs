//! Dedicated desktop adapter for verified hosted-web Artifact bytes.
//!
//! This deliberately does not share `browser::DesktopBrowserState`: that host
//! owns external navigation, persistent profiles, diagnostics, devtools, and
//! an eval surface. This module consumes the existing Artifact token/locator
//! registration and Protocol-authored response table for a restricted,
//! nonpersistent Wry child only.

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
#[cfg(unix)]
use std::io::Read;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, Runtime, State, Window};

#[cfg(target_os = "macos")]
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObject},
    AllocAnyThread, ClassType, DefinedClass,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{
    NSDictionary, NSKeyValueChangeKey, NSKeyValueObservingOptions,
    NSObjectNSKeyValueObserverRegistration, NSObjectProtocol, NSString,
};
#[cfg(target_os = "macos")]
use std::borrow::Cow;
#[cfg(target_os = "macos")]
use std::cell::RefCell;
#[cfg(target_os = "macos")]
use std::{ffi::c_void, ptr::null_mut};
#[cfg(target_os = "macos")]
use tauri::Emitter;
#[cfg(target_os = "macos")]
use url::Url;

const CACHE_NAMESPACE: &str = "happier-plugin-ui-artifacts-v1";
const CACHE_DIRECTORY: &str = "hosted-artifacts-v1";
#[cfg(target_os = "macos")]
const ARTIFACT_SCHEME: &str = "happier-hosted-artifact";
#[cfg(target_os = "macos")]
const HOST_EVENT: &str = "desktop-hosted-artifact-event";
#[cfg(target_os = "macos")]
const MAX_IPC_MESSAGE_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StorageLocator {
    namespace: String,
    account_key_hash: String,
    artifact_key_hash: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CacheFileInput {
    relative_path: String,
    digest: String,
    byte_size: usize,
    bytes_base64: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CacheFileExpectation {
    relative_path: String,
    digest: String,
    byte_size: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CachedFileMetadata {
    relative_path: String,
    digest: String,
    byte_size: usize,
    stored_file_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CacheManifest {
    version: u8,
    identity_key_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    entry_relative_path: Option<String>,
    files: Vec<CachedFileMetadata>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CacheReadRequest {
    locator: StorageLocator,
    identity_key_hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CacheWriteRequest {
    locator: StorageLocator,
    identity_key_hash: String,
    entry_relative_path: Option<String>,
    files: Vec<CacheFileInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CacheDescribeRequest {
    locator: StorageLocator,
    identity_key_hash: String,
    files: Vec<CacheFileExpectation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CacheRemoveRequest {
    locator: StorageLocator,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CacheRemoveAccountRequest {
    namespace: String,
    account_key_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheReadFile {
    relative_path: String,
    digest: String,
    byte_size: usize,
    bytes_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheReadResult {
    identity_key_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    entry_relative_path: Option<String>,
    files: Vec<CacheReadFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheResourceDescription {
    locator: StorageLocator,
    resources: Vec<CachedResourceDescription>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedResourceDescription {
    stored_file_name: String,
    digest: String,
    byte_size: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostedArtifactResource {
    resource_id: String,
    stored_file_name: String,
    digest: String,
    byte_size: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PolicyHeadersWire {
    #[serde(rename = "Cache-Control")]
    cache_control: String,
    #[serde(rename = "Content-Security-Policy")]
    content_security_policy: String,
    #[serde(rename = "ETag")]
    etag: String,
    #[serde(rename = "X-Content-Type-Options")]
    x_content_type_options: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum PolicyOutcomeWire {
    Content {
        resource_id: String,
        content_type: String,
        headers: PolicyHeadersWire,
    },
    Rejected {
        code: String,
        status: u16,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PolicyRouteWire {
    path: String,
    outcome: PolicyOutcomeWire,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PolicyTableWire {
    version: u8,
    routes: Vec<PolicyRouteWire>,
    path_fallback: Option<PolicyOutcomeWire>,
}

#[derive(Clone, Debug)]
struct PolicyHeaders {
    cache_control: String,
    content_security_policy: String,
    etag: String,
    x_content_type_options: String,
}

#[derive(Clone, Debug)]
struct PolicyContent {
    resource_id: String,
    content_type: String,
    headers: PolicyHeaders,
}

#[derive(Clone, Debug)]
enum PolicyOutcome {
    Content(PolicyContent),
    Rejected { status: u16 },
}

#[derive(Clone, Debug)]
struct PolicyTable {
    routes: HashMap<String, PolicyOutcome>,
    path_fallback: Option<PolicyContent>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedArtifactRegistrationInput {
    token: String,
    storage_partition_id: String,
    storage_locator: StorageLocator,
    resources: Vec<HostedArtifactResource>,
    policy_table: PolicyTableWire,
}

#[derive(Clone, Debug)]
struct RegisteredArtifact {
    storage_partition_id: String,
    storage_locator: StorageLocator,
    resources: HashMap<String, HostedArtifactResource>,
    policy_table: PolicyTable,
}

#[derive(Clone, Debug)]
struct HostedArtifactView {
    token: String,
}

#[derive(Default)]
struct HostedArtifactInner {
    registrations: HashMap<String, RegisteredArtifact>,
    // This is only the non-Send Wry child-handle index's synchronized metadata,
    // not a server frame-session or currentness registry. Artifact retains all
    // logical ownership; a removed registration makes every view command fail.
    views: HashMap<String, HostedArtifactView>,
}

pub struct DesktopHostedArtifactState {
    inner: Arc<Mutex<HostedArtifactInner>>,
    cache_write_lock: Mutex<()>,
}

impl Default for DesktopHostedArtifactState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HostedArtifactInner::default())),
            cache_write_lock: Mutex::new(()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HostedArtifactRegistrationResult {
    Registered,
    Unavailable {
        code: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        capability: Option<&'static str>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedArtifactOpenViewRequest {
    view_id: String,
    token: String,
    initial_path_and_query: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedArtifactViewRequest {
    view_id: String,
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedArtifactBoundsRequest {
    view_id: String,
    token: String,
    bounds: HostedArtifactBounds,
    visible: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedArtifactBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedArtifactPostMessageRequest {
    view_id: String,
    token: String,
    message: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HostedArtifactViewResult {
    Opened,
    Ok,
    Unavailable { code: &'static str },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HostedArtifactGoBackResult {
    Handled { handled: bool },
    Unavailable { code: &'static str },
}

fn is_lower_hex(value: &str, expected_length: usize) -> bool {
    value.len() == expected_length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_digest(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .map(|hash| is_lower_hex(hash, 64))
        .unwrap_or(false)
}

fn is_stored_file_name(value: &str) -> bool {
    value
        .strip_suffix(".bin")
        .map(|hash| is_lower_hex(hash, 64))
        .unwrap_or(false)
}

fn is_resource_id(value: &str) -> bool {
    let Some(rest) = value.strip_prefix('r') else {
        return false;
    };
    !rest.is_empty()
        && rest.bytes().all(|byte| byte.is_ascii_digit())
        && (rest == "0" || !rest.starts_with('0'))
}

fn is_opaque_id(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some(first) if first.is_ascii_alphabetic())
        && value.len() >= 2
        && value.len() <= 256
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
}

fn is_partition_id(value: &str) -> bool {
    value
        .strip_prefix("hpa_")
        .map(|hash| is_lower_hex(hash, 64))
        .unwrap_or(false)
}

fn validate_locator(locator: &StorageLocator) -> Result<(), String> {
    if locator.namespace != CACHE_NAMESPACE
        || !is_lower_hex(&locator.account_key_hash, 64)
        || !is_lower_hex(&locator.artifact_key_hash, 64)
    {
        return Err("invalid hosted Artifact cache locator".to_string());
    }
    Ok(())
}

fn has_windows_path_syntax(path: &str) -> bool {
    path.contains('\\')
        || path.starts_with("//")
        || path.split('/').any(|segment| {
            let bytes = segment.as_bytes();
            bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
        })
}

fn normalize_artifact_path(path: &str) -> Option<String> {
    if path.contains('\0') || has_windows_path_syntax(path) {
        return None;
    }
    let trimmed = path.trim().trim_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let mut segments = Vec::new();
    for segment in trimmed.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            segments.pop()?;
            continue;
        }
        segments.push(segment);
    }
    (!segments.is_empty()).then(|| segments.join("/"))
}

#[derive(Debug)]
struct NormalizedRequestPath {
    path: String,
    directory_request: bool,
}

fn has_encoded_traversal_or_separator(raw_path: &str) -> bool {
    for raw_segment in raw_path.split('/') {
        if !raw_segment.contains('%') {
            continue;
        }
        let bytes = raw_segment.as_bytes();
        for (index, byte) in bytes.iter().enumerate() {
            if *byte != b'%' {
                continue;
            }
            let Some((high, low)) = bytes.get(index + 1).zip(bytes.get(index + 2)) else {
                return true;
            };
            if !high.is_ascii_hexdigit() || !low.is_ascii_hexdigit() {
                return true;
            }
        }
        let Ok(decoded) = percent_decode_str(raw_segment).decode_utf8() else {
            return true;
        };
        if decoded == "." || decoded == ".." || decoded.contains('/') || decoded.contains('\\') {
            return true;
        }
    }
    false
}

fn normalize_request_path(request_path: &str) -> Option<NormalizedRequestPath> {
    let raw_path = request_path.split('?').next().unwrap_or(request_path);
    if has_encoded_traversal_or_separator(raw_path) {
        return None;
    }
    let decoded = percent_decode_str(raw_path).decode_utf8().ok()?;
    if decoded.contains('\0') || has_windows_path_syntax(&decoded) {
        return None;
    }
    let directory_request = decoded.ends_with('/');
    let trimmed = decoded.trim_start_matches('/');
    if trimmed.is_empty() {
        return Some(NormalizedRequestPath {
            path: String::new(),
            directory_request: false,
        });
    }
    Some(NormalizedRequestPath {
        path: normalize_artifact_path(&trimmed)?,
        directory_request,
    })
}

fn has_file_extension(path: &str) -> bool {
    let basename = path.rsplit('/').next().unwrap_or(path);
    basename.rfind('.').map(|index| index > 0).unwrap_or(false)
}

fn expected_status_for_rejection(code: &str) -> Option<u16> {
    match code {
        "invalid_request_path" => Some(400),
        "mime_type_not_allowed" => Some(415),
        "asset_not_declared" | "directory_listing_disabled" | "source_map_unavailable" => Some(404),
        _ => None,
    }
}

fn parse_policy_headers(headers: PolicyHeadersWire) -> Result<PolicyHeaders, String> {
    if headers.cache_control.is_empty()
        || headers.content_security_policy.is_empty()
        || headers.etag.is_empty()
        || headers.x_content_type_options.is_empty()
    {
        return Err("invalid hosted Artifact policy headers".to_string());
    }
    Ok(PolicyHeaders {
        cache_control: headers.cache_control,
        content_security_policy: headers.content_security_policy,
        etag: headers.etag,
        x_content_type_options: headers.x_content_type_options,
    })
}

fn parse_policy_outcome(outcome: PolicyOutcomeWire) -> Result<PolicyOutcome, String> {
    match outcome {
        PolicyOutcomeWire::Content {
            resource_id,
            content_type,
            headers,
        } => {
            if !is_resource_id(&resource_id) || content_type.is_empty() {
                return Err("invalid hosted Artifact policy content".to_string());
            }
            Ok(PolicyOutcome::Content(PolicyContent {
                resource_id,
                content_type,
                headers: parse_policy_headers(headers)?,
            }))
        }
        PolicyOutcomeWire::Rejected { code, status } => {
            if expected_status_for_rejection(&code) != Some(status) {
                return Err("invalid hosted Artifact policy rejection".to_string());
            }
            Ok(PolicyOutcome::Rejected { status })
        }
    }
}

fn parse_policy_table(table: PolicyTableWire) -> Result<PolicyTable, String> {
    if table.version != 1 {
        return Err("unsupported hosted Artifact policy table".to_string());
    }
    let mut routes = HashMap::new();
    for route in table.routes {
        let is_canonical = route.path.is_empty()
            || normalize_artifact_path(&route.path).as_deref() == Some(route.path.as_str());
        if !is_canonical || routes.contains_key(&route.path) {
            return Err("invalid hosted Artifact policy route".to_string());
        }
        routes.insert(route.path, parse_policy_outcome(route.outcome)?);
    }
    let path_fallback = match table.path_fallback {
        Some(outcome) => match parse_policy_outcome(outcome)? {
            PolicyOutcome::Content(content) => Some(content),
            PolicyOutcome::Rejected { .. } => {
                return Err("invalid hosted Artifact fallback policy".to_string());
            }
        },
        None => None,
    };
    Ok(PolicyTable {
        routes,
        path_fallback,
    })
}

fn policy_content_resource_ids(table: &PolicyTable) -> impl Iterator<Item = &str> {
    table
        .routes
        .values()
        .filter_map(|outcome| match outcome {
            PolicyOutcome::Content(content) => Some(content.resource_id.as_str()),
            PolicyOutcome::Rejected { .. } => None,
        })
        .chain(
            table
                .path_fallback
                .iter()
                .map(|content| content.resource_id.as_str()),
        )
}

fn resolve_policy_request(table: &PolicyTable, request_path: &str) -> PolicyOutcome {
    let Some(path) = normalize_request_path(request_path) else {
        return PolicyOutcome::Rejected { status: 400 };
    };
    if path.directory_request && !path.path.is_empty() {
        return PolicyOutcome::Rejected { status: 404 };
    }
    if let Some(outcome) = table.routes.get(&path.path) {
        return outcome.clone();
    }
    if !path.directory_request && !has_file_extension(&path.path) {
        if let Some(fallback) = &table.path_fallback {
            return PolicyOutcome::Content(fallback.clone());
        }
    }
    PolicyOutcome::Rejected { status: 404 }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn file_name_for(relative_path: &str, digest: &str) -> String {
    let mut input = String::with_capacity(relative_path.len() + digest.len() + 1);
    input.push_str(relative_path);
    input.push('\0');
    input.push_str(digest);
    format!("{}.bin", sha256_hex(input.as_bytes()))
}

fn cache_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(CACHE_DIRECTORY))
        .map_err(|error| error.to_string())
}

fn artifact_directory(root: &Path, locator: &StorageLocator) -> Result<PathBuf, String> {
    validate_locator(locator)?;
    Ok(root
        .join(CACHE_NAMESPACE)
        .join(&locator.account_key_hash)
        .join(&locator.artifact_key_hash))
}

/**
 * The cache root is a private native boundary, not a path supplied by an
 * Artifact. Every existing read/serve/delete path first proves that it is an
 * ordinary directory, then that its canonical target is the exact expected
 * path below this root. This rejects a tampered cache symlink instead of
 * following it into another Account, another Artifact, or an arbitrary local
 * file.
 */
fn resolve_existing_cache_root(root: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(root).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("hosted Artifact cache root is not a direct directory".to_string());
    }
    fs::canonicalize(root).map_err(|error| error.to_string())
}

fn prepare_cache_root_for_write(root: &Path) -> Result<PathBuf, String> {
    // Creation may race a local tamperer, so immediately re-read the final
    // filesystem object through the same no-symlink root gate as reads.
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    resolve_existing_cache_root(root)
}

fn resolve_existing_cache_directory_within(
    root: &Path,
    directory: &Path,
) -> Result<PathBuf, String> {
    let canonical_root = resolve_existing_cache_root(root)?;
    let relative_directory = directory
        .strip_prefix(root)
        .map_err(|_| "hosted Artifact cache directory is outside its root".to_string())?;
    if relative_directory.as_os_str().is_empty()
        || relative_directory
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("invalid hosted Artifact cache directory path".to_string());
    }
    let expected_directory = canonical_root.join(relative_directory);
    let metadata = fs::symlink_metadata(directory).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("hosted Artifact cache directory is not a direct directory".to_string());
    }
    let canonical_directory = fs::canonicalize(directory).map_err(|error| error.to_string())?;
    if canonical_directory != expected_directory {
        return Err("hosted Artifact cache directory does not match its locator".to_string());
    }
    Ok(canonical_directory)
}

fn resolve_existing_artifact_directory(
    root: &Path,
    locator: &StorageLocator,
) -> Result<PathBuf, String> {
    let directory = artifact_directory(root, locator)?;
    resolve_existing_cache_directory_within(root, &directory)
}

fn prepare_artifact_parent_for_write(
    root: &Path,
    locator: &StorageLocator,
) -> Result<PathBuf, String> {
    let directory = artifact_directory(root, locator)?;
    let parent = directory
        .parent()
        .ok_or_else(|| "hosted Artifact cache directory has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    // `parent` is intentionally re-resolved after creation. A symlink at any
    // hash-qualified component must not redirect a cache write outside root.
    resolve_existing_cache_directory_within(root, parent)?;
    Ok(directory)
}

fn resolve_confined_cache_file(directory: &Path, file_name: &str) -> Result<PathBuf, String> {
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains('\0')
    {
        return Err("invalid hosted Artifact cache file name".to_string());
    }
    let candidate = directory.join(file_name);
    let metadata = fs::symlink_metadata(&candidate).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("hosted Artifact cache file is not a direct file".to_string());
    }
    let canonical_file = fs::canonicalize(&candidate).map_err(|error| error.to_string())?;
    if canonical_file.parent() != Some(directory) {
        return Err("hosted Artifact cache file escapes its directory".to_string());
    }
    Ok(canonical_file)
}

fn read_confined_cache_file(directory: &Path, file_name: &str) -> Result<Vec<u8>, String> {
    let path = resolve_confined_cache_file(directory, file_name)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        // `canonicalize` above establishes containment, while O_NOFOLLOW
        // closes the final-component replacement race before this native
        // reader can disclose an outside file through cache or protocol IO.
        let mut file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|error| error.to_string())?;
        if !file
            .metadata()
            .map_err(|error| error.to_string())?
            .is_file()
        {
            return Err("hosted Artifact cache file is not a direct file".to_string());
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok(bytes)
    }
    #[cfg(not(unix))]
    {
        fs::read(path).map_err(|error| error.to_string())
    }
}

fn account_directory(
    root: &Path,
    namespace: &str,
    account_key_hash: &str,
) -> Result<PathBuf, String> {
    if namespace != CACHE_NAMESPACE || !is_lower_hex(account_key_hash, 64) {
        return Err("invalid hosted Artifact cache account locator".to_string());
    }
    Ok(root.join(CACHE_NAMESPACE).join(account_key_hash))
}

fn validate_manifest(manifest: &CacheManifest, locator: &StorageLocator) -> Result<(), String> {
    if manifest.version != 1
        || manifest.identity_key_hash != locator.artifact_key_hash
        || !is_lower_hex(&manifest.identity_key_hash, 64)
        || manifest.files.is_empty()
    {
        return Err("invalid hosted Artifact cache manifest".to_string());
    }
    let mut paths = HashSet::new();
    let mut file_names = HashSet::new();
    for file in &manifest.files {
        if normalize_artifact_path(&file.relative_path).as_deref()
            != Some(file.relative_path.as_str())
            || !is_digest(&file.digest)
            || !is_stored_file_name(&file.stored_file_name)
            || file_name_for(&file.relative_path, &file.digest) != file.stored_file_name
            || !paths.insert(file.relative_path.as_str())
            || !file_names.insert(file.stored_file_name.as_str())
        {
            return Err("invalid hosted Artifact cache file manifest".to_string());
        }
    }
    if let Some(entry) = &manifest.entry_relative_path {
        if !paths.contains(entry.as_str()) {
            return Err("hosted Artifact cache entry is not declared".to_string());
        }
    }
    Ok(())
}

fn read_manifest(directory: &Path, locator: &StorageLocator) -> Result<CacheManifest, String> {
    let bytes = read_confined_cache_file(directory, "manifest.json")?;
    let manifest =
        serde_json::from_slice::<CacheManifest>(&bytes).map_err(|error| error.to_string())?;
    validate_manifest(&manifest, locator)?;
    Ok(manifest)
}

fn read_file_bytes(directory: &Path, file: &CachedFileMetadata) -> Result<Vec<u8>, String> {
    let bytes = read_confined_cache_file(directory, &file.stored_file_name)?;
    if bytes.len() != file.byte_size || format!("sha256:{}", sha256_hex(&bytes)) != file.digest {
        return Err("hosted Artifact cache file integrity mismatch".to_string());
    }
    Ok(bytes)
}

fn remove_cache_directory_if_present_within(root: &Path, path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(
                    "hosted Artifact cache deletion refused a non-directory path".to_string(),
                );
            }
            let canonical = resolve_existing_cache_directory_within(root, path)?;
            fs::remove_dir_all(canonical).map_err(|error| error.to_string())
        }
    }
}

#[tauri::command]
pub fn desktop_hosted_artifact_cache_read(
    app: AppHandle,
    input: CacheReadRequest,
) -> Result<Option<CacheReadResult>, String> {
    validate_locator(&input.locator)?;
    if input.identity_key_hash != input.locator.artifact_key_hash {
        return Ok(None);
    }
    let root = cache_root(&app)?;
    let directory = match resolve_existing_artifact_directory(&root, &input.locator) {
        Ok(directory) => directory,
        Err(_) => return Ok(None),
    };
    let manifest = match read_manifest(&directory, &input.locator) {
        Ok(manifest) => manifest,
        Err(_) => return Ok(None),
    };
    let mut files = Vec::with_capacity(manifest.files.len());
    for file in &manifest.files {
        let bytes = match read_file_bytes(&directory, file) {
            Ok(bytes) => bytes,
            Err(_) => return Ok(None),
        };
        files.push(CacheReadFile {
            relative_path: file.relative_path.clone(),
            digest: file.digest.clone(),
            byte_size: file.byte_size,
            bytes_base64: BASE64_STANDARD.encode(bytes),
        });
    }
    Ok(Some(CacheReadResult {
        identity_key_hash: manifest.identity_key_hash,
        entry_relative_path: manifest.entry_relative_path,
        files,
    }))
}

#[tauri::command]
pub fn desktop_hosted_artifact_cache_write(
    app: AppHandle,
    state: State<'_, DesktopHostedArtifactState>,
    input: CacheWriteRequest,
) -> Result<(), String> {
    validate_locator(&input.locator)?;
    if input.identity_key_hash != input.locator.artifact_key_hash || input.files.is_empty() {
        return Err("invalid hosted Artifact cache write".to_string());
    }
    let _write_guard = state
        .cache_write_lock
        .lock()
        .map_err(|_| "hosted Artifact cache write lock poisoned".to_string())?;
    let root = cache_root(&app)?;
    prepare_cache_root_for_write(&root)?;
    let directory = prepare_artifact_parent_for_write(&root, &input.locator)?;
    let partial = directory.with_extension("partial");
    remove_cache_directory_if_present_within(&root, &partial)?;
    fs::create_dir(&partial).map_err(|error| error.to_string())?;

    let write_result = (|| -> Result<CacheManifest, String> {
        let mut paths = HashSet::new();
        let mut names = HashSet::new();
        let mut files = Vec::with_capacity(input.files.len());
        for file in &input.files {
            if normalize_artifact_path(&file.relative_path).as_deref()
                != Some(file.relative_path.as_str())
                || !is_digest(&file.digest)
                || !paths.insert(file.relative_path.as_str())
            {
                return Err("invalid hosted Artifact cache file".to_string());
            }
            let bytes = BASE64_STANDARD
                .decode(file.bytes_base64.as_bytes())
                .map_err(|_| "invalid hosted Artifact cache file encoding".to_string())?;
            if bytes.len() != file.byte_size
                || format!("sha256:{}", sha256_hex(&bytes)) != file.digest
            {
                return Err("invalid hosted Artifact cache file integrity".to_string());
            }
            let stored_file_name = file_name_for(&file.relative_path, &file.digest);
            if !names.insert(stored_file_name.clone()) {
                return Err("duplicate hosted Artifact cache stored file".to_string());
            }
            let path = partial.join(&stored_file_name);
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(|error| error.to_string())?;
            output
                .write_all(&bytes)
                .map_err(|error| error.to_string())?;
            output.sync_all().map_err(|error| error.to_string())?;
            files.push(CachedFileMetadata {
                relative_path: file.relative_path.clone(),
                digest: file.digest.clone(),
                byte_size: file.byte_size,
                stored_file_name,
            });
        }
        if let Some(entry) = &input.entry_relative_path {
            if !paths.contains(entry.as_str()) {
                return Err("hosted Artifact cache entry is not declared".to_string());
            }
        }
        let manifest = CacheManifest {
            version: 1,
            identity_key_hash: input.identity_key_hash.clone(),
            entry_relative_path: input.entry_relative_path.clone(),
            files,
        };
        validate_manifest(&manifest, &input.locator)?;
        let manifest_bytes = serde_json::to_vec(&manifest).map_err(|error| error.to_string())?;
        let mut manifest_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(partial.join("manifest.json"))
            .map_err(|error| error.to_string())?;
        // The manifest is the only commit marker and is written after every
        // verified data member. A partial directory is never readable as a
        // valid record.
        manifest_file
            .write_all(&manifest_bytes)
            .map_err(|error| error.to_string())?;
        manifest_file
            .sync_all()
            .map_err(|error| error.to_string())?;
        Ok(manifest)
    })();
    if let Err(error) = write_result {
        let _ = remove_cache_directory_if_present_within(&root, &partial);
        return Err(error);
    }
    remove_cache_directory_if_present_within(&root, &directory)?;
    fs::rename(&partial, &directory).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_hosted_artifact_cache_describe(
    app: AppHandle,
    input: CacheDescribeRequest,
) -> Result<Option<CacheResourceDescription>, String> {
    validate_locator(&input.locator)?;
    if input.identity_key_hash != input.locator.artifact_key_hash || input.files.is_empty() {
        return Ok(None);
    }
    let root = cache_root(&app)?;
    let directory = match resolve_existing_artifact_directory(&root, &input.locator) {
        Ok(directory) => directory,
        Err(_) => return Ok(None),
    };
    let manifest = match read_manifest(&directory, &input.locator) {
        Ok(manifest) if manifest.identity_key_hash == input.identity_key_hash => manifest,
        _ => return Ok(None),
    };
    let metadata_by_path = manifest
        .files
        .iter()
        .map(|file| (file.relative_path.as_str(), file))
        .collect::<HashMap<_, _>>();
    let mut declared_paths = HashSet::new();
    let mut resources = Vec::with_capacity(input.files.len());
    for expected in &input.files {
        if normalize_artifact_path(&expected.relative_path).as_deref()
            != Some(expected.relative_path.as_str())
            || !is_digest(&expected.digest)
            || !declared_paths.insert(expected.relative_path.as_str())
        {
            return Ok(None);
        }
        let Some(file) = metadata_by_path.get(expected.relative_path.as_str()) else {
            return Ok(None);
        };
        if file.digest != expected.digest || file.byte_size != expected.byte_size {
            return Ok(None);
        }
        if read_file_bytes(&directory, file).is_err() {
            return Ok(None);
        }
        resources.push(CachedResourceDescription {
            stored_file_name: file.stored_file_name.clone(),
            digest: file.digest.clone(),
            byte_size: file.byte_size,
        });
    }
    Ok(Some(CacheResourceDescription {
        locator: input.locator,
        resources,
    }))
}

#[tauri::command]
pub fn desktop_hosted_artifact_cache_remove(
    app: AppHandle,
    state: State<'_, DesktopHostedArtifactState>,
    input: CacheRemoveRequest,
) -> Result<(), String> {
    let _write_guard = state
        .cache_write_lock
        .lock()
        .map_err(|_| "hosted Artifact cache write lock poisoned".to_string())?;
    let root = cache_root(&app)?;
    let directory = artifact_directory(&root, &input.locator)?;
    remove_cache_directory_if_present_within(&root, &directory)
}

#[tauri::command]
pub fn desktop_hosted_artifact_cache_remove_account(
    app: AppHandle,
    state: State<'_, DesktopHostedArtifactState>,
    input: CacheRemoveAccountRequest,
) -> Result<(), String> {
    let _write_guard = state
        .cache_write_lock
        .lock()
        .map_err(|_| "hosted Artifact cache write lock poisoned".to_string())?;
    let root = cache_root(&app)?;
    let directory = account_directory(&root, &input.namespace, &input.account_key_hash)?;
    remove_cache_directory_if_present_within(&root, &directory)
}

fn registered_artifact_from_input(
    input: HostedArtifactRegistrationInput,
) -> Result<(String, RegisteredArtifact), String> {
    if !is_opaque_id(&input.token) || !is_partition_id(&input.storage_partition_id) {
        return Err("invalid hosted Artifact registration identity".to_string());
    }
    validate_locator(&input.storage_locator)?;
    let policy_table = parse_policy_table(input.policy_table)?;
    let mut resources = HashMap::new();
    let mut stored_file_names = HashSet::new();
    for resource in input.resources {
        if !is_resource_id(&resource.resource_id)
            || !is_stored_file_name(&resource.stored_file_name)
            || !is_digest(&resource.digest)
            || resources.contains_key(&resource.resource_id)
            || !stored_file_names.insert(resource.stored_file_name.clone())
        {
            return Err("invalid hosted Artifact registration resource".to_string());
        }
        resources.insert(resource.resource_id.clone(), resource);
    }
    if resources.is_empty()
        || policy_content_resource_ids(&policy_table)
            .any(|resource_id| !resources.contains_key(resource_id))
    {
        return Err("hosted Artifact policy resource is unavailable".to_string());
    }
    Ok((
        input.token,
        RegisteredArtifact {
            storage_partition_id: input.storage_partition_id,
            storage_locator: input.storage_locator,
            resources,
            policy_table,
        },
    ))
}

#[tauri::command]
pub fn desktop_hosted_artifact_register(
    state: State<'_, DesktopHostedArtifactState>,
    input: HostedArtifactRegistrationInput,
) -> HostedArtifactRegistrationResult {
    // Direct Wry has verified nonpersistent child-view behavior only on macOS.
    // Keep all other desktop targets typed unavailable instead of treating a
    // generic browser profile or an unverified child embedding as equivalent.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, input);
        return HostedArtifactRegistrationResult::Unavailable {
            code: "hosted_web_profile_isolation_unavailable",
            capability: Some("MULTI_PROFILE"),
        };
    }

    #[cfg(target_os = "macos")]
    {
        let Ok((token, registration)) = registered_artifact_from_input(input) else {
            return HostedArtifactRegistrationResult::Unavailable {
                code: "native_artifact_resource_registration_failed",
                capability: None,
            };
        };
        let mut inner = match state.inner.lock() {
            Ok(inner) => inner,
            Err(_) => {
                return HostedArtifactRegistrationResult::Unavailable {
                    code: "native_artifact_resource_registration_failed",
                    capability: None,
                };
            }
        };
        if inner.registrations.contains_key(&token) {
            return HostedArtifactRegistrationResult::Unavailable {
                code: "native_artifact_resource_registration_failed",
                capability: None,
            };
        }
        inner.registrations.insert(token, registration);
        HostedArtifactRegistrationResult::Registered
    }
}

#[tauri::command]
pub fn desktop_hosted_artifact_unregister(
    state: State<'_, DesktopHostedArtifactState>,
    token: String,
) -> bool {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, token);
        return false;
    }

    #[cfg(target_os = "macos")]
    {
        let view_ids = {
            let mut inner = match state.inner.lock() {
                Ok(inner) => inner,
                Err(_) => return false,
            };
            if inner.registrations.remove(&token).is_none() {
                return false;
            }
            let view_ids = inner
                .views
                .iter()
                .filter_map(|(view_id, view)| (view.token == token).then(|| view_id.clone()))
                .collect::<Vec<_>>();
            for view_id in &view_ids {
                inner.views.remove(view_id);
            }
            view_ids
        };
        // Physical child destruction is intentionally a native best effort
        // after the registration is removed. The caller does not wait: JS
        // Artifact currentness has already synchronously retired the token.
        for view_id in view_ids {
            remove_native_view(&view_id);
        }
        true
    }
}

fn view_is_active(inner: &HostedArtifactInner, view_id: &str, token: &str) -> bool {
    inner
        .views
        .get(view_id)
        .map(|view| view.token == token && inner.registrations.contains_key(token))
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn artifact_initial_url(partition_id: &str, initial_path_and_query: &str) -> Option<String> {
    if !is_partition_id(partition_id)
        || !initial_path_and_query.starts_with('/')
        || initial_path_and_query.contains('#')
        || initial_path_and_query.len() > 16 * 1024
    {
        return None;
    }
    let candidate = format!("{ARTIFACT_SCHEME}://{partition_id}{initial_path_and_query}");
    let parsed = Url::parse(&candidate).ok()?;
    (parsed.scheme() == ARTIFACT_SCHEME
        && parsed.host_str() == Some(partition_id)
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.port().is_none())
    .then_some(candidate)
}

#[cfg(target_os = "macos")]
fn is_allowed_artifact_navigation(raw_url: &str, partition_id: &str) -> bool {
    let Ok(url) = Url::parse(raw_url) else {
        return false;
    };
    url.scheme() == ARTIFACT_SCHEME
        && url.host_str() == Some(partition_id)
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
}

#[cfg(target_os = "macos")]
fn protocol_response(
    status: u16,
    headers: Option<&PolicyHeaders>,
    content_type: Option<&str>,
    body: Vec<u8>,
) -> wry::http::Response<Cow<'static, [u8]>> {
    let mut builder = wry::http::Response::builder().status(status);
    if let Some(headers) = headers {
        builder = builder
            .header("Cache-Control", &headers.cache_control)
            .header("Content-Security-Policy", &headers.content_security_policy)
            .header("ETag", &headers.etag)
            .header("X-Content-Type-Options", &headers.x_content_type_options);
    }
    if let Some(content_type) = content_type {
        builder = builder.header("Content-Type", content_type);
    }
    builder.body(Cow::Owned(body)).unwrap_or_else(|_| {
        wry::http::Response::builder()
            .status(404)
            .body(Cow::Owned(Vec::new()))
            .expect("static protocol response is valid")
    })
}

#[cfg(target_os = "macos")]
fn serve_artifact_protocol_request(
    inner: &Arc<Mutex<HostedArtifactInner>>,
    cache_root: &Path,
    token: &str,
    partition_id: &str,
    request: wry::http::Request<Vec<u8>>,
) -> wry::http::Response<Cow<'static, [u8]>> {
    // A registered Artifact is a read-only byte source. Reject every
    // non-GET method before path policy or cache access so this custom scheme
    // cannot become an alternate form/fetch endpoint for the guest.
    if request.method() != wry::http::Method::GET {
        return protocol_response(405, None, None, Vec::new());
    }
    let request_url = request.uri().to_string();
    if !is_allowed_artifact_navigation(&request_url, partition_id) {
        return protocol_response(404, None, None, Vec::new());
    }
    let registration = match inner.lock() {
        Ok(inner) => inner
            .registrations
            .get(token)
            .filter(|registration| registration.storage_partition_id == partition_id)
            .cloned(),
        Err(_) => None,
    };
    let Some(registration) = registration else {
        return protocol_response(404, None, None, Vec::new());
    };
    let content = match resolve_policy_request(&registration.policy_table, request.uri().path()) {
        PolicyOutcome::Content(content) => content,
        PolicyOutcome::Rejected { status } => {
            return protocol_response(status, None, None, Vec::new());
        }
    };
    let Some(resource) = registration.resources.get(&content.resource_id) else {
        return protocol_response(404, None, None, Vec::new());
    };
    let directory =
        match resolve_existing_artifact_directory(cache_root, &registration.storage_locator) {
            Ok(directory) => directory,
            Err(_) => return protocol_response(404, None, None, Vec::new()),
        };
    let bytes = match read_confined_cache_file(&directory, &resource.stored_file_name) {
        Ok(bytes)
            if bytes.len() == resource.byte_size
                && format!("sha256:{}", sha256_hex(&bytes)) == resource.digest =>
        {
            bytes
        }
        _ => return protocol_response(404, None, None, Vec::new()),
    };
    protocol_response(
        200,
        Some(&content.headers),
        Some(&content.content_type),
        bytes,
    )
}

#[cfg(target_os = "macos")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostedArtifactHostEvent {
    view_id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_go_back: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
}

#[cfg(target_os = "macos")]
fn emit_hosted_artifact_event<R: Runtime>(window: &Window<R>, event: HostedArtifactHostEvent) {
    let _ = window.emit(HOST_EVENT, event);
}

#[cfg(target_os = "macos")]
struct HostedArtifactHistoryObserverIvars {
    object: Retained<wry::WryWebView>,
    handler: Box<dyn Fn(bool)>,
}

#[cfg(target_os = "macos")]
define_class!(
    #[unsafe(super(NSObject))]
    #[name = "HappierHostedArtifactHistoryObserver"]
    #[ivars = HostedArtifactHistoryObserverIvars]
    struct HostedArtifactHistoryObserver;

    impl HostedArtifactHistoryObserver {
        #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
        fn observe_value_for_key_path(
            &self,
            key_path: Option<&NSString>,
            _of_object: Option<&AnyObject>,
            _change: Option<&NSDictionary<NSKeyValueChangeKey, AnyObject>>,
            _context: *mut c_void,
        ) {
            if key_path.is_some_and(|key_path| key_path.to_string() == "canGoBack") {
                let can_go_back: bool = unsafe { msg_send![&*self.ivars().object, canGoBack] };
                (self.ivars().handler)(can_go_back);
            }
        }
    }

    unsafe impl NSObjectProtocol for HostedArtifactHistoryObserver {}
);

#[cfg(target_os = "macos")]
impl HostedArtifactHistoryObserver {
    fn new(webview: Retained<wry::WryWebView>, handler: Box<dyn Fn(bool)>) -> Retained<Self> {
        let observer = Self::alloc().set_ivars(HostedArtifactHistoryObserverIvars {
            object: webview,
            handler,
        });
        let observer: Retained<Self> = unsafe { msg_send![super(observer), init] };
        unsafe {
            observer
                .ivars()
                .object
                .addObserver_forKeyPath_options_context(
                    &observer,
                    &NSString::from_str("canGoBack"),
                    NSKeyValueObservingOptions::New,
                    null_mut(),
                );
        }
        observer
    }
}

#[cfg(target_os = "macos")]
impl Drop for HostedArtifactHistoryObserver {
    fn drop(&mut self) {
        unsafe {
            self.ivars()
                .object
                .removeObserver_forKeyPath(self, &NSString::from_str("canGoBack"));
        }
    }
}

#[cfg(target_os = "macos")]
thread_local! {
    static NATIVE_HOSTED_ARTIFACT_VIEWS: RefCell<HashMap<String, WryHostedArtifactView>> =
        RefCell::new(HashMap::new());
}

#[cfg(target_os = "macos")]
fn replace_native_view(view_id: String, view: WryHostedArtifactView) {
    NATIVE_HOSTED_ARTIFACT_VIEWS.with(|views| {
        views.borrow_mut().insert(view_id, view);
    });
}

#[cfg(target_os = "macos")]
fn remove_native_view(view_id: &str) {
    NATIVE_HOSTED_ARTIFACT_VIEWS.with(|views| {
        views.borrow_mut().remove(view_id);
    });
}

#[cfg(target_os = "macos")]
fn with_native_view<T>(
    view_id: &str,
    operation: impl FnOnce(&WryHostedArtifactView) -> Result<T, String>,
) -> Result<T, String> {
    NATIVE_HOSTED_ARTIFACT_VIEWS.with(|views| {
        let views = views.borrow();
        let Some(view) = views.get(view_id) else {
            return Err("desktop hosted Artifact child view is missing".to_string());
        };
        operation(view)
    })
}

#[cfg(target_os = "macos")]
struct WryHostedArtifactView {
    // Wry requires the context to outlive its child WebView. It is constructed
    // with no profile path and `with_incognito(true)`, so it cannot become the
    // generic desktop browser's persistent profile owner.
    _context: wry::WebContext,
    // Keeps the host-native KVO subscription alive while the direct Wry child
    // exists. It is the factual history source; guests cannot publish this
    // state through the Artifact bridge.
    _history_observer: Retained<HostedArtifactHistoryObserver>,
    webview: wry::WebView,
}

#[cfg(target_os = "macos")]
impl WryHostedArtifactView {
    fn new<R: Runtime>(
        window: &Window<R>,
        request: &HostedArtifactOpenViewRequest,
        partition_id: &str,
        inner: Arc<Mutex<HostedArtifactInner>>,
        cache_root: PathBuf,
    ) -> Result<Self, String> {
        use wry::{WebViewBuilderExtDarwin, WebViewExtMacOS};

        let initial_url = artifact_initial_url(partition_id, &request.initial_path_and_query)
            .ok_or_else(|| "invalid hosted Artifact initial path".to_string())?;
        let mut context = wry::WebContext::new(None);
        context.set_allows_automation(false);
        let token_for_protocol = request.token.clone();
        let partition_for_protocol = partition_id.to_string();
        let token_for_navigation = request.token.clone();
        let partition_for_navigation = partition_id.to_string();
        let view_id_for_load = request.view_id.clone();
        let window_for_load = window.clone();
        let view_id_for_ipc = request.view_id.clone();
        let window_for_ipc = window.clone();
        let view_id_for_crash = request.view_id.clone();
        let window_for_crash = window.clone();
        let builder = wry::WebViewBuilder::new_with_web_context(&mut context)
            .with_id(request.view_id.as_str())
            .with_url(initial_url)
            .with_visible(false)
            .with_incognito(true)
            .with_devtools(false)
            .with_navigation_handler(move |url| {
                // Token is captured only to make this closure's binding
                // explicit; permitted navigation remains only the registered
                // partition custom-protocol origin, never arbitrary URLs.
                let _ = &token_for_navigation;
                is_allowed_artifact_navigation(&url, &partition_for_navigation)
            })
            .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
            .with_download_started_handler(|_, _| false)
            .with_initialization_script_for_main_only(HOSTED_ARTIFACT_IPC_BOOTSTRAP, true)
            .with_custom_protocol(
                ARTIFACT_SCHEME.into(),
                move |_webview_id, protocol_request| {
                    serve_artifact_protocol_request(
                        &inner,
                        &cache_root,
                        &token_for_protocol,
                        &partition_for_protocol,
                        protocol_request,
                    )
                },
            )
            .with_on_page_load_handler(move |event, _url| {
                let kind = match event {
                    wry::PageLoadEvent::Started => "loadStarted",
                    wry::PageLoadEvent::Finished => "loadFinished",
                };
                emit_hosted_artifact_event(
                    &window_for_load,
                    HostedArtifactHostEvent {
                        view_id: view_id_for_load.clone(),
                        kind,
                        can_go_back: None,
                        message: None,
                        code: None,
                    },
                );
            })
            .with_ipc_handler(move |request| {
                let message = request.into_body();
                if message.len() > MAX_IPC_MESSAGE_BYTES
                    || serde_json::from_str::<serde_json::Value>(&message)
                        .ok()
                        .filter(serde_json::Value::is_object)
                        .is_none()
                {
                    return;
                }
                emit_hosted_artifact_event(
                    &window_for_ipc,
                    HostedArtifactHostEvent {
                        view_id: view_id_for_ipc.clone(),
                        kind: "message",
                        can_go_back: None,
                        message: Some(message),
                        code: None,
                    },
                );
            })
            .with_on_web_content_process_terminate_handler(move || {
                emit_hosted_artifact_event(
                    &window_for_crash,
                    HostedArtifactHostEvent {
                        view_id: view_id_for_crash.clone(),
                        kind: "error",
                        can_go_back: None,
                        message: None,
                        code: Some("hosted_web_content_process_terminated"),
                    },
                );
            });
        // `with_incognito(true)` is the nonpersistent-store authority. Do not
        // add a data-store identifier: that is the generic browser's profile
        // mechanism and would be a second persistence path here.
        let webview = builder
            .build_as_child(window)
            .map_err(|error| error.to_string())?;
        let native_webview = webview.webview();
        let view_id_for_history = request.view_id.clone();
        let window_for_history = window.clone();
        let history_observer = HostedArtifactHistoryObserver::new(
            native_webview.clone(),
            Box::new(move |can_go_back| {
                emit_hosted_artifact_event(
                    &window_for_history,
                    HostedArtifactHostEvent {
                        view_id: view_id_for_history.clone(),
                        kind: "historyState",
                        can_go_back: Some(can_go_back),
                        message: None,
                        code: None,
                    },
                );
            }),
        );
        let can_go_back = unsafe { native_webview.as_super().canGoBack() };
        emit_hosted_artifact_event(
            window,
            HostedArtifactHostEvent {
                view_id: request.view_id.clone(),
                kind: "historyState",
                can_go_back: Some(can_go_back),
                message: None,
                code: None,
            },
        );
        Ok(Self {
            _context: context,
            _history_observer: history_observer,
            webview,
        })
    }

    fn set_bounds(&self, bounds: &HostedArtifactBounds, visible: bool) -> Result<(), String> {
        if !bounds.x.is_finite()
            || !bounds.y.is_finite()
            || !bounds.width.is_finite()
            || !bounds.height.is_finite()
            || bounds.width < 0.0
            || bounds.height < 0.0
        {
            return Err("invalid hosted Artifact child bounds".to_string());
        }
        let rect = wry::Rect {
            position: wry::dpi::LogicalPosition::new(bounds.x, bounds.y).into(),
            size: wry::dpi::LogicalSize::new(bounds.width, bounds.height).into(),
        };
        self.webview
            .set_bounds(rect)
            .map_err(|error| error.to_string())?;
        self.webview
            .set_visible(visible)
            .map_err(|error| error.to_string())
    }

    fn post_host_message(&self, message: &serde_json::Value) -> Result<(), String> {
        let data = serde_json::to_string(message).map_err(|error| error.to_string())?;
        // This is a fixed host-to-guest transport delivery expression, not a
        // user-controlled eval command. The only interpolated fragment is a
        // JSON serialization of an already schema-validated host envelope.
        let script = format!(
            "window.dispatchEvent(new MessageEvent('message',{{data:{data},origin:location.origin}}));"
        );
        self.webview
            .evaluate_script(&script)
            .map_err(|error| error.to_string())
    }

    fn go_back(&self) -> Result<bool, String> {
        use wry::WebViewExtMacOS;

        let native_webview = self.webview.webview();
        let native_webview = native_webview.as_super();
        if !unsafe { native_webview.canGoBack() } {
            return Ok(false);
        }
        Ok(unsafe { native_webview.goBack() }.is_some())
    }
}

// The bootstrap gives the guest exactly the established native-webview
// postMessage carrier. It does not expose `__TAURI__`, invoke, filesystem,
// devtools, navigation, arbitrary JS evaluation, or a generic ambient bridge.
const HOSTED_ARTIFACT_IPC_BOOTSTRAP: &str = r#"
(() => {
  const postMessage = (message) => {
    if (typeof message !== 'string' || !window.ipc || typeof window.ipc.postMessage !== 'function') return;
    window.ipc.postMessage(message);
  };
  Object.defineProperty(window, 'ReactNativeWebView', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ postMessage }),
  });
})();
"#;

#[tauri::command]
pub fn desktop_hosted_artifact_open_view<R: Runtime>(
    window: Window<R>,
    state: State<'_, DesktopHostedArtifactState>,
    request: HostedArtifactOpenViewRequest,
) -> HostedArtifactViewResult {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, state, request);
        return HostedArtifactViewResult::Unavailable {
            code: "desktop_hosted_artifact_platform_unavailable",
        };
    }

    #[cfg(target_os = "macos")]
    {
        let partition_id = {
            let inner = match state.inner.lock() {
                Ok(inner) => inner,
                Err(_) => {
                    return HostedArtifactViewResult::Unavailable {
                        code: "desktop_hosted_artifact_unavailable",
                    };
                }
            };
            if inner.views.contains_key(&request.view_id) {
                return HostedArtifactViewResult::Unavailable {
                    code: "desktop_hosted_artifact_view_already_open",
                };
            }
            let Some(registration) = inner.registrations.get(&request.token) else {
                return HostedArtifactViewResult::Unavailable {
                    code: "desktop_hosted_artifact_registration_unavailable",
                };
            };
            registration.storage_partition_id.clone()
        };
        let root = match cache_root(window.app_handle()) {
            Ok(root) => root,
            Err(_) => {
                return HostedArtifactViewResult::Unavailable {
                    code: "desktop_hosted_artifact_unavailable",
                };
            }
        };
        let view = match WryHostedArtifactView::new(
            &window,
            &request,
            &partition_id,
            Arc::clone(&state.inner),
            root,
        ) {
            Ok(view) => view,
            Err(_) => {
                return HostedArtifactViewResult::Unavailable {
                    code: "desktop_hosted_artifact_unavailable",
                };
            }
        };
        let mut inner = match state.inner.lock() {
            Ok(inner) => inner,
            Err(_) => {
                return HostedArtifactViewResult::Unavailable {
                    code: "desktop_hosted_artifact_unavailable",
                };
            }
        };
        if !inner.registrations.contains_key(&request.token)
            || inner.views.contains_key(&request.view_id)
        {
            return HostedArtifactViewResult::Unavailable {
                code: "desktop_hosted_artifact_registration_unavailable",
            };
        }
        inner.views.insert(
            request.view_id.clone(),
            HostedArtifactView {
                token: request.token.clone(),
            },
        );
        // Keep registration/view metadata and the native child installation in
        // one critical section. `unregister` retires both under this lock, so
        // it cannot remove a view before this newly-created child is visible
        // to native teardown.
        replace_native_view(request.view_id, view);
        HostedArtifactViewResult::Opened
    }
}

#[tauri::command]
pub fn desktop_hosted_artifact_set_bounds(
    state: State<'_, DesktopHostedArtifactState>,
    request: HostedArtifactBoundsRequest,
) -> HostedArtifactViewResult {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, request);
        return HostedArtifactViewResult::Unavailable {
            code: "desktop_hosted_artifact_platform_unavailable",
        };
    }

    #[cfg(target_os = "macos")]
    {
        // Hold the registration lock through the native mutation. Otherwise an
        // unregister could retire the token after the check and before the
        // child is reached, allowing a stale bounds update to affect it.
        let applied = state
            .inner
            .lock()
            .map(|inner| {
                view_is_active(&inner, &request.view_id, &request.token)
                    && with_native_view(&request.view_id, |view| {
                        view.set_bounds(&request.bounds, request.visible)
                    })
                    .is_ok()
            })
            .unwrap_or(false);
        if !applied {
            return HostedArtifactViewResult::Unavailable {
                code: "desktop_hosted_artifact_view_unavailable",
            };
        }
        HostedArtifactViewResult::Ok
    }
}

#[tauri::command]
pub fn desktop_hosted_artifact_post_message(
    state: State<'_, DesktopHostedArtifactState>,
    request: HostedArtifactPostMessageRequest,
) -> HostedArtifactViewResult {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, request);
        return HostedArtifactViewResult::Unavailable {
            code: "desktop_hosted_artifact_platform_unavailable",
        };
    }

    #[cfg(target_os = "macos")]
    {
        // As with bounds, serialize currentness with delivery. A command that
        // observes a retired token must never reach the child view.
        let delivered = state
            .inner
            .lock()
            .map(|inner| {
                view_is_active(&inner, &request.view_id, &request.token)
                    && with_native_view(&request.view_id, |view| {
                        view.post_host_message(&request.message)
                    })
                    .is_ok()
            })
            .unwrap_or(false);
        if !delivered {
            return HostedArtifactViewResult::Unavailable {
                code: "desktop_hosted_artifact_view_unavailable",
            };
        }
        HostedArtifactViewResult::Ok
    }
}

#[tauri::command]
pub fn desktop_hosted_artifact_go_back(
    state: State<'_, DesktopHostedArtifactState>,
    request: HostedArtifactViewRequest,
) -> HostedArtifactGoBackResult {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, request);
        return HostedArtifactGoBackResult::Unavailable {
            code: "desktop_hosted_artifact_platform_unavailable",
        };
    }

    #[cfg(target_os = "macos")]
    {
        // Hold the registration lock through the native operation, just as
        // bounds and host-message delivery do. A retired token must not send
        // a Back command to a reused child view.
        let handled = state.inner.lock().ok().and_then(|inner| {
            if !view_is_active(&inner, &request.view_id, &request.token) {
                return None;
            }
            with_native_view(&request.view_id, |view| view.go_back()).ok()
        });
        match handled {
            Some(handled) => HostedArtifactGoBackResult::Handled { handled },
            None => HostedArtifactGoBackResult::Unavailable {
                code: "desktop_hosted_artifact_view_unavailable",
            },
        }
    }
}

#[tauri::command]
pub fn desktop_hosted_artifact_close_view(
    state: State<'_, DesktopHostedArtifactState>,
    request: HostedArtifactViewRequest,
) -> HostedArtifactViewResult {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, request);
        return HostedArtifactViewResult::Unavailable {
            code: "desktop_hosted_artifact_platform_unavailable",
        };
    }

    #[cfg(target_os = "macos")]
    {
        let removed = state
            .inner
            .lock()
            .map(|mut inner| {
                if !view_is_active(&inner, &request.view_id, &request.token) {
                    return false;
                }
                inner.views.remove(&request.view_id);
                true
            })
            .unwrap_or(false);
        if !removed {
            return HostedArtifactViewResult::Unavailable {
                code: "desktop_hosted_artifact_view_unavailable",
            };
        }
        remove_native_view(&request.view_id);
        HostedArtifactViewResult::Ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    const DESKTOP_HOSTED_ARTIFACT_COMMANDS: &[&str] = &[
        "desktop_hosted_artifact_register",
        "desktop_hosted_artifact_unregister",
        "desktop_hosted_artifact_cache_read",
        "desktop_hosted_artifact_cache_write",
        "desktop_hosted_artifact_cache_describe",
        "desktop_hosted_artifact_cache_remove",
        "desktop_hosted_artifact_cache_remove_account",
        "desktop_hosted_artifact_open_view",
        "desktop_hosted_artifact_set_bounds",
        "desktop_hosted_artifact_post_message",
        "desktop_hosted_artifact_go_back",
        "desktop_hosted_artifact_close_view",
    ];

    fn manifest_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    fn permission_name_for_command(command: &str) -> String {
        format!("allow-{}", command.replace('_', "-"))
    }

    #[test]
    fn hosted_artifact_commands_are_registered_for_generated_acl_and_main_capability() {
        let manifest_dir = manifest_dir();
        let build_rs =
            fs::read_to_string(manifest_dir.join("build.rs")).expect("build.rs should be readable");
        let default_capability: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(manifest_dir.join("capabilities").join("default.json"))
                .expect("default Tauri capability should be readable"),
        )
        .expect("default Tauri capability should be valid JSON");
        let permissions = default_capability["permissions"]
            .as_array()
            .expect("default Tauri capability permissions should be an array");

        for command in DESKTOP_HOSTED_ARTIFACT_COMMANDS {
            let permission = permission_name_for_command(command);
            assert!(
                build_rs.contains(&format!("\"{command}\"")),
                "build.rs APP_TAURI_COMMANDS should include {command}",
            );
            assert!(
                permissions.contains(&serde_json::Value::String(permission.clone())),
                "default capability should include {permission}",
            );

            let generated_permission = manifest_dir
                .join("permissions")
                .join("autogenerated")
                .join(format!("{command}.toml"));
            let raw = fs::read_to_string(&generated_permission).unwrap_or_else(|error| {
                panic!(
                    "failed to read generated permission {}: {error}",
                    generated_permission.display()
                )
            });
            assert!(
                raw.contains(&format!("identifier = \"{permission}\"")),
                "{} should declare {permission}",
                generated_permission.display(),
            );
            assert!(
                raw.contains(&format!("commands.allow = [\"{command}\"]")),
                "{} should allow {command}",
                generated_permission.display(),
            );
        }
    }

    fn valid_content(resource_id: &str) -> serde_json::Value {
        json!({
            "kind": "content",
            "resourceId": resource_id,
            "contentType": "text/html; charset=utf-8",
            "headers": {
                "Cache-Control": "public, max-age=31536000, immutable",
                "Content-Security-Policy": "default-src 'none'",
                "ETag": "\"sha256:test\"",
                "X-Content-Type-Options": "nosniff"
            }
        })
    }

    #[test]
    fn native_table_interpreter_uses_the_serialized_policy_and_rejects_encoded_traversal() {
        let wire = serde_json::from_value::<PolicyTableWire>(json!({
            "version": 1,
            "routes": [
                { "path": "", "outcome": valid_content("r0") },
                { "path": "assets/app.js", "outcome": valid_content("r1") }
            ],
            "pathFallback": valid_content("r0")
        }))
        .expect("test table should deserialize");
        let table = parse_policy_table(wire).expect("test table should validate");

        assert!(matches!(
            resolve_policy_request(&table, "/settings/team"),
            PolicyOutcome::Content(PolicyContent { resource_id, .. }) if resource_id == "r0"
        ));
        assert!(matches!(
            resolve_policy_request(&table, "/assets%2Fapp.js"),
            PolicyOutcome::Rejected { status: 400 }
        ));
        assert!(matches!(
            resolve_policy_request(&table, "/assets/%"),
            PolicyOutcome::Rejected { status: 400 }
        ));
        assert!(matches!(
            resolve_policy_request(&table, "/assets/"),
            PolicyOutcome::Rejected { status: 404 }
        ));
    }

    #[test]
    fn registration_requires_every_policy_content_resource_to_be_declared() {
        let input = serde_json::from_value::<HostedArtifactRegistrationInput>(json!({
            "token": "hpat_test_token",
            "storagePartitionId": format!("hpa_{}", "a".repeat(64)),
            "storageLocator": {
                "namespace": CACHE_NAMESPACE,
                "accountKeyHash": "b".repeat(64),
                "artifactKeyHash": "c".repeat(64)
            },
            "resources": [{
                "resourceId": "r0",
                "storedFileName": format!("{}.bin", "d".repeat(64)),
                "digest": format!("sha256:{}", "e".repeat(64)),
                "byteSize": 1
            }],
            "policyTable": {
                "version": 1,
                "routes": [{ "path": "", "outcome": valid_content("r1") }]
            }
        }))
        .expect("test registration should deserialize");

        assert!(registered_artifact_from_input(input).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn protocol_serves_registered_artifact_bytes_only_to_get_requests() {
        let temporary = tempfile::tempdir().expect("temporary cache root should exist");
        let root = temporary.path().join("cache");
        let locator = StorageLocator {
            namespace: CACHE_NAMESPACE.to_string(),
            account_key_hash: "a".repeat(64),
            artifact_key_hash: "b".repeat(64),
        };
        let directory =
            artifact_directory(&root, &locator).expect("cache directory should resolve");
        fs::create_dir_all(&directory).expect("artifact cache directory should exist");

        let bytes = b"registered static Artifact bytes".to_vec();
        let digest = format!("sha256:{}", sha256_hex(&bytes));
        let stored_file_name = file_name_for("index.html", &digest);
        fs::write(directory.join(&stored_file_name), &bytes)
            .expect("registered resource fixture should exist");

        let token = "hpat_test_token".to_string();
        let partition_id = format!("hpa_{}", "c".repeat(64));
        let registration = RegisteredArtifact {
            storage_partition_id: partition_id.clone(),
            storage_locator: locator,
            resources: HashMap::from([(
                "r0".to_string(),
                HostedArtifactResource {
                    resource_id: "r0".to_string(),
                    stored_file_name,
                    digest,
                    byte_size: bytes.len(),
                },
            )]),
            policy_table: PolicyTable {
                routes: HashMap::from([(
                    "".to_string(),
                    PolicyOutcome::Content(PolicyContent {
                        resource_id: "r0".to_string(),
                        content_type: "text/html; charset=utf-8".to_string(),
                        headers: PolicyHeaders {
                            cache_control: "public, max-age=31536000, immutable".to_string(),
                            content_security_policy: "default-src 'none'".to_string(),
                            etag: "\"sha256:test\"".to_string(),
                            x_content_type_options: "nosniff".to_string(),
                        },
                    }),
                )]),
                path_fallback: None,
            },
        };
        let inner = Arc::new(Mutex::new(HostedArtifactInner {
            registrations: HashMap::from([(token.clone(), registration)]),
            views: HashMap::new(),
        }));
        let request = wry::http::Request::builder()
            .method("POST")
            .uri(format!("{ARTIFACT_SCHEME}://{partition_id}/"))
            .body(Vec::new())
            .expect("protocol request should be valid");

        let response =
            serve_artifact_protocol_request(&inner, &root, &token, &partition_id, request);

        assert_eq!(response.status().as_u16(), 405);
        assert!(response.body().is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn protocol_serves_a_registered_relative_artifact_graph_from_native_cache() {
        let temporary = tempfile::tempdir().expect("temporary cache root should exist");
        let root = temporary.path().join("cache");
        let locator = StorageLocator {
            namespace: CACHE_NAMESPACE.to_string(),
            account_key_hash: "a".repeat(64),
            artifact_key_hash: "b".repeat(64),
        };
        let directory =
            artifact_directory(&root, &locator).expect("cache directory should resolve");
        fs::create_dir_all(&directory).expect("artifact cache directory should exist");

        // The desktop transport never uses a browser/network cache: every
        // relative document member resolves through this registration into the
        // confined native Artifact directory.
        let assets = vec![
            (
                "",
                "text/html; charset=utf-8",
                b"<img src=\"assets/logo.png\"><script src=\"assets/app.js\"></script>".to_vec(),
            ),
            (
                "assets/app.js",
                "text/javascript; charset=utf-8",
                b"import './app.css';".to_vec(),
            ),
            (
                "assets/app.css",
                "text/css; charset=utf-8",
                b"@font-face { src: url('./ui.woff2'); }".to_vec(),
            ),
            ("assets/logo.png", "image/png", vec![0x89, 0x50, 0x4e, 0x47]),
            (
                "assets/ui.woff2",
                "font/woff2",
                vec![0x77, 0x4f, 0x46, 0x32],
            ),
        ];
        let mut resources = HashMap::new();
        let mut routes = HashMap::new();
        for (index, (path, content_type, bytes)) in assets.iter().enumerate() {
            let resource_id = format!("r{index}");
            let digest = format!("sha256:{}", sha256_hex(bytes));
            let stored_file_name = file_name_for(path, &digest);
            fs::write(directory.join(&stored_file_name), bytes)
                .expect("registered resource fixture should exist");
            resources.insert(
                resource_id.clone(),
                HostedArtifactResource {
                    resource_id: resource_id.clone(),
                    stored_file_name,
                    digest: digest.clone(),
                    byte_size: bytes.len(),
                },
            );
            routes.insert(
                (*path).to_string(),
                PolicyOutcome::Content(PolicyContent {
                    resource_id,
                    content_type: (*content_type).to_string(),
                    headers: PolicyHeaders {
                        cache_control: "public, max-age=31536000, immutable".to_string(),
                        content_security_policy: "default-src 'none'".to_string(),
                        etag: format!("\"{digest}\""),
                        x_content_type_options: "nosniff".to_string(),
                    },
                }),
            );
        }

        let token = "hpat_test_token".to_string();
        let partition_id = format!("hpa_{}", "c".repeat(64));
        let registration = RegisteredArtifact {
            storage_partition_id: partition_id.clone(),
            storage_locator: locator,
            resources,
            policy_table: PolicyTable {
                routes,
                path_fallback: None,
            },
        };
        let inner = Arc::new(Mutex::new(HostedArtifactInner {
            registrations: HashMap::from([(token.clone(), registration)]),
            views: HashMap::new(),
        }));

        for (path, content_type, bytes) in assets {
            let request = wry::http::Request::builder()
                .method("GET")
                .uri(format!("{ARTIFACT_SCHEME}://{partition_id}/{path}"))
                .body(Vec::new())
                .expect("protocol request should be valid");
            let response =
                serve_artifact_protocol_request(&inner, &root, &token, &partition_id, request);

            assert_eq!(response.status().as_u16(), 200, "{path}");
            assert_eq!(
                response
                    .headers()
                    .get("Content-Type")
                    .expect("content type should be set")
                    .to_str()
                    .expect("content type should be valid"),
                content_type,
                "{path}"
            );
            assert_eq!(response.body().as_ref(), bytes.as_slice(), "{path}");
        }

        // Native token retirement is the protocol's currentness boundary: the
        // same cache bytes are no longer addressable after the canonical
        // registration has been removed.
        inner
            .lock()
            .expect("registration lock should be available")
            .registrations
            .remove(&token);
        let retired_request = wry::http::Request::builder()
            .method("GET")
            .uri(format!("{ARTIFACT_SCHEME}://{partition_id}/"))
            .body(Vec::new())
            .expect("retired protocol request should be valid");
        let retired_response =
            serve_artifact_protocol_request(&inner, &root, &token, &partition_id, retired_request);
        assert_eq!(retired_response.status().as_u16(), 404);
        assert!(retired_response.body().is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn cache_and_protocol_reject_a_resource_symlink_that_escapes_the_artifact_directory() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().expect("temporary cache root should exist");
        let root = temporary.path().join("cache");
        let locator = StorageLocator {
            namespace: CACHE_NAMESPACE.to_string(),
            account_key_hash: "a".repeat(64),
            artifact_key_hash: "b".repeat(64),
        };
        let directory =
            artifact_directory(&root, &locator).expect("cache directory should resolve");
        fs::create_dir_all(&directory).expect("artifact cache directory should exist");

        let bytes = b"outside the artifact cache".to_vec();
        let outside = temporary.path().join("outside.bin");
        fs::write(&outside, &bytes).expect("outside fixture should exist");
        let digest = format!("sha256:{}", sha256_hex(&bytes));
        let stored_file_name = file_name_for("index.html", &digest);
        symlink(&outside, directory.join(&stored_file_name))
            .expect("resource fixture should be a symlink escape");
        let file = CachedFileMetadata {
            relative_path: "index.html".to_string(),
            digest: digest.clone(),
            byte_size: bytes.len(),
            stored_file_name: stored_file_name.clone(),
        };

        // Cache reads and custom-protocol serving must use the same confined
        // resource reader; otherwise either path could disclose a file outside
        // this Artifact's private cache directory.
        assert!(read_file_bytes(&directory, &file).is_err());

        let token = "hpat_test_token".to_string();
        let partition_id = format!("hpa_{}", "c".repeat(64));
        let registration = RegisteredArtifact {
            storage_partition_id: partition_id.clone(),
            storage_locator: locator,
            resources: HashMap::from([(
                "r0".to_string(),
                HostedArtifactResource {
                    resource_id: "r0".to_string(),
                    stored_file_name,
                    digest,
                    byte_size: bytes.len(),
                },
            )]),
            policy_table: PolicyTable {
                routes: HashMap::from([(
                    "".to_string(),
                    PolicyOutcome::Content(PolicyContent {
                        resource_id: "r0".to_string(),
                        content_type: "text/html; charset=utf-8".to_string(),
                        headers: PolicyHeaders {
                            cache_control: "public, max-age=31536000, immutable".to_string(),
                            content_security_policy: "default-src 'none'".to_string(),
                            etag: "\"sha256:test\"".to_string(),
                            x_content_type_options: "nosniff".to_string(),
                        },
                    }),
                )]),
                path_fallback: None,
            },
        };
        let inner = Arc::new(Mutex::new(HostedArtifactInner {
            registrations: HashMap::from([(token.clone(), registration)]),
            views: HashMap::new(),
        }));
        let request = wry::http::Request::builder()
            .uri(format!("{ARTIFACT_SCHEME}://{partition_id}/"))
            .body(Vec::new())
            .expect("protocol request should be valid");
        let response =
            serve_artifact_protocol_request(&inner, &root, &token, &partition_id, request);

        assert_eq!(response.status().as_u16(), 404);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn cache_rejects_an_account_component_symlink_before_read_protocol_or_delete() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().expect("temporary cache root should exist");
        let root = temporary.path().join("cache");
        let locator = StorageLocator {
            namespace: CACHE_NAMESPACE.to_string(),
            account_key_hash: "a".repeat(64),
            artifact_key_hash: "c".repeat(64),
        };
        let redirected_locator = StorageLocator {
            namespace: CACHE_NAMESPACE.to_string(),
            account_key_hash: "b".repeat(64),
            artifact_key_hash: locator.artifact_key_hash.clone(),
        };
        let redirected_directory = artifact_directory(&root, &redirected_locator)
            .expect("redirected cache directory should resolve");
        fs::create_dir_all(&redirected_directory)
            .expect("redirected artifact cache directory should exist");
        let requested_directory =
            artifact_directory(&root, &locator).expect("requested cache directory should resolve");
        symlink(
            root.join(CACHE_NAMESPACE)
                .join(&redirected_locator.account_key_hash),
            root.join(CACHE_NAMESPACE).join(&locator.account_key_hash),
        )
        .expect("account component should be a symlink redirect");

        let bytes = b"other Account artifact bytes".to_vec();
        let digest = format!("sha256:{}", sha256_hex(&bytes));
        let stored_file_name = file_name_for("index.html", &digest);
        fs::write(redirected_directory.join(&stored_file_name), &bytes)
            .expect("redirected resource fixture should exist");

        let token = "hpat_test_token".to_string();
        let partition_id = format!("hpa_{}", "d".repeat(64));
        let registration = RegisteredArtifact {
            storage_partition_id: partition_id.clone(),
            storage_locator: locator.clone(),
            resources: HashMap::from([(
                "r0".to_string(),
                HostedArtifactResource {
                    resource_id: "r0".to_string(),
                    stored_file_name,
                    digest,
                    byte_size: bytes.len(),
                },
            )]),
            policy_table: PolicyTable {
                routes: HashMap::from([(
                    "".to_string(),
                    PolicyOutcome::Content(PolicyContent {
                        resource_id: "r0".to_string(),
                        content_type: "text/html; charset=utf-8".to_string(),
                        headers: PolicyHeaders {
                            cache_control: "public, max-age=31536000, immutable".to_string(),
                            content_security_policy: "default-src 'none'".to_string(),
                            etag: "\"sha256:test\"".to_string(),
                            x_content_type_options: "nosniff".to_string(),
                        },
                    }),
                )]),
                path_fallback: None,
            },
        };
        let inner = Arc::new(Mutex::new(HostedArtifactInner {
            registrations: HashMap::from([(token.clone(), registration)]),
            views: HashMap::new(),
        }));
        let request = wry::http::Request::builder()
            .uri(format!("{ARTIFACT_SCHEME}://{partition_id}/"))
            .body(Vec::new())
            .expect("protocol request should be valid");

        // The exact locator path must not be redirected to another Account
        // that happens to remain below the shared cache root. These three
        // consumers all rely on the same canonical resolver.
        let cache_lookup_rejected = resolve_existing_artifact_directory(&root, &locator).is_err();
        let protocol_response =
            serve_artifact_protocol_request(&inner, &root, &token, &partition_id, request);
        let deletion_rejected =
            remove_cache_directory_if_present_within(&root, &requested_directory).is_err();
        let redirected_directory_survived = redirected_directory.exists();

        assert!(cache_lookup_rejected);
        assert_eq!(protocol_response.status().as_u16(), 404);
        assert!(deletion_rejected);
        assert!(redirected_directory_survived);
    }
}
