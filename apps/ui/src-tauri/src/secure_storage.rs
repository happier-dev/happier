use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use keyring::{Entry, Error as KeyringError};
use sha2::{Digest, Sha256};

const SERVICE_NAMESPACE: &str = "dev.happier.desktop.device-local-storage.v1";
const KEY_DOMAIN: &[u8] = b"happier.desktop.device-local-storage.v1\0";
/// The shipped app's bundle identifier (`tauri.conf.json`). Its items live under the
/// unscoped service, so released installs keep reading what they already stored.
const RELEASE_IDENTIFIER: &str = "dev.happier.app";

/// The OS keychain service this build flavour owns.
///
/// Every other flavour (preview, public dev, stack/QA identifiers, debug builds) gets its own
/// service. Sharing one made a rebuilt, differently signed app read another build's items, and
/// macOS then held the first credential read on an access prompt for an item it never wrote.
pub(crate) fn service_namespace_for_build(identifier: &str, debug_build: bool) -> String {
    match (identifier == RELEASE_IDENTIFIER, debug_build) {
        (true, false) => SERVICE_NAMESPACE.to_owned(),
        (_, false) => format!("{SERVICE_NAMESPACE}.{identifier}"),
        (_, true) => format!("{SERVICE_NAMESPACE}.{identifier}.debug"),
    }
}

fn opaque_scoped_key(key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(KEY_DOMAIN);
    hasher.update(key.as_bytes());
    format!("{:x}", hasher.finalize())
}

trait SecureStorageBackend {
    fn read(&self, key: &str) -> Result<Option<String>, String>;
    fn write(&self, key: &str, value: &str) -> Result<(), String>;
    fn remove(&self, key: &str) -> Result<(), String>;
}

struct OsKeyringBackend {
    service: String,
}

impl OsKeyringBackend {
    fn entry(&self, key: &str) -> Result<Entry, String> {
        Entry::new(&self.service, &opaque_scoped_key(key))
            .map_err(|error| format!("secure storage entry unavailable: {error}"))
    }
}

impl SecureStorageBackend for OsKeyringBackend {
    fn read(&self, key: &str) -> Result<Option<String>, String> {
        match self.entry(key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(format!("secure storage read failed: {error}")),
        }
    }

    fn write(&self, key: &str, value: &str) -> Result<(), String> {
        self.entry(key)?
            .set_password(value)
            .map_err(|error| format!("secure storage write failed: {error}"))
    }

    fn remove(&self, key: &str) -> Result<(), String> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(format!("secure storage remove failed: {error}")),
        }
    }
}

/// The app's one device-local custody owner, shared by every window of this process.
///
/// The keychain is the persistent store. Every window reads and writes through this owner
/// (the `desktop_secure_storage_*` commands), so it also holds the last value it read or wrote
/// for each key: windows read that over IPC instead of asking the keychain on every
/// authenticated request, and a compare-and-swap in one window re-reads what another window
/// just wrote. Single-instance guarantees no second process writes this service.
///
/// The lock is held across the keychain call so a read miss can never publish a value older
/// than a write that finished while it waited. A failed call leaves the key uncached.
struct DeviceLocalCustody<B: SecureStorageBackend> {
    backend: B,
    values: Mutex<HashMap<String, Option<String>>>,
}

impl<B: SecureStorageBackend> DeviceLocalCustody<B> {
    fn new(backend: B) -> Self {
        Self { backend, values: Mutex::new(HashMap::new()) }
    }

    fn values(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, Option<String>>>, String> {
        self.values.lock().map_err(|_| "secure storage owner unavailable".to_owned())
    }

    fn read(&self, key: &str) -> Result<Option<String>, String> {
        let mut values = self.values()?;
        if let Some(value) = values.get(key) {
            return Ok(value.clone());
        }
        let value = self.backend.read(key)?;
        values.insert(key.to_owned(), value.clone());
        Ok(value)
    }

    fn write(&self, key: &str, value: &str) -> Result<(), String> {
        let mut values = self.values()?;
        // Whatever a failed call left in the keychain, the next read asks it.
        values.remove(key);
        self.backend.write(key, value)?;
        values.insert(key.to_owned(), Some(value.to_owned()));
        Ok(())
    }

    fn remove(&self, key: &str) -> Result<(), String> {
        let mut values = self.values()?;
        values.remove(key);
        self.backend.remove(key)?;
        values.insert(key.to_owned(), None);
        Ok(())
    }
}

/// Managed Tauri state: this build flavour's custody owner.
#[derive(Clone)]
pub struct DesktopSecureStorage(Arc<DeviceLocalCustody<OsKeyringBackend>>);

impl DesktopSecureStorage {
    pub fn for_build(identifier: &str) -> Self {
        let service = service_namespace_for_build(identifier, cfg!(debug_assertions));
        Self(Arc::new(DeviceLocalCustody::new(OsKeyringBackend { service })))
    }
}

async fn run_blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("secure storage operation could not complete: {error}"))?
}

#[tauri::command]
pub async fn desktop_secure_storage_read(
    storage: tauri::State<'_, DesktopSecureStorage>,
    key: String,
) -> Result<Option<String>, String> {
    let owner = storage.0.clone();
    run_blocking(move || owner.read(&key)).await
}

#[tauri::command]
pub async fn desktop_secure_storage_write(
    storage: tauri::State<'_, DesktopSecureStorage>,
    key: String,
    value: String,
) -> Result<(), String> {
    let owner = storage.0.clone();
    run_blocking(move || owner.write(&key, &value)).await
}

#[tauri::command]
pub async fn desktop_secure_storage_remove(
    storage: tauri::State<'_, DesktopSecureStorage>,
    key: String,
) -> Result<(), String> {
    let owner = storage.0.clone();
    run_blocking(move || owner.remove(&key)).await
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use super::{
        opaque_scoped_key, service_namespace_for_build, DeviceLocalCustody, SecureStorageBackend,
        SERVICE_NAMESPACE,
    };

    #[derive(Default)]
    struct MemoryBackend {
        value: std::sync::Mutex<Option<String>>,
    }

    impl SecureStorageBackend for MemoryBackend {
        fn read(&self, _key: &str) -> Result<Option<String>, String> {
            Ok(self.value.lock().expect("memory backend lock").clone())
        }

        fn write(&self, _key: &str, value: &str) -> Result<(), String> {
            *self.value.lock().expect("memory backend lock") = Some(value.to_owned());
            Ok(())
        }

        fn remove(&self, _key: &str) -> Result<(), String> {
            *self.value.lock().expect("memory backend lock") = None;
            Ok(())
        }
    }

    /// The OS keychain boundary, counted: every call here is one keychain round trip.
    #[derive(Default)]
    struct CountingKeychain {
        items: Mutex<HashMap<String, String>>,
        reads: AtomicUsize,
        fail_next_write: Mutex<bool>,
        fail_next_read: Mutex<bool>,
    }

    impl SecureStorageBackend for &CountingKeychain {
        fn read(&self, key: &str) -> Result<Option<String>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if std::mem::take(&mut *self.fail_next_read.lock().unwrap()) {
                return Err("user denied keychain access".into());
            }
            Ok(self.items.lock().unwrap().get(key).cloned())
        }

        fn write(&self, key: &str, value: &str) -> Result<(), String> {
            if std::mem::take(&mut *self.fail_next_write.lock().unwrap()) {
                return Err("keychain write failed".into());
            }
            self.items.lock().unwrap().insert(key.to_owned(), value.to_owned());
            Ok(())
        }

        fn remove(&self, key: &str) -> Result<(), String> {
            self.items.lock().unwrap().remove(key);
            Ok(())
        }
    }

    #[test]
    fn repeated_reads_across_windows_reach_the_keychain_once_per_key() {
        let keychain = CountingKeychain::default();
        keychain.items.lock().unwrap().insert("credential".into(), "v1".into());
        let owner = DeviceLocalCustody::new(&keychain);

        // Boot plus navigation in two windows: 61 authenticated requests and one absent key.
        for _ in 0..61 {
            assert_eq!(owner.read("credential").unwrap(), Some("v1".into()));
        }
        assert_eq!(owner.read("absent").unwrap(), None);
        assert_eq!(owner.read("absent").unwrap(), None);

        assert_eq!(keychain.reads.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn compare_and_swap_in_one_window_sees_another_windows_write() {
        let keychain = CountingKeychain::default();
        keychain.items.lock().unwrap().insert("credential".into(), "v1".into());
        let owner = DeviceLocalCustody::new(&keychain);

        // Window A and window B both observed v1.
        let observed_by_a = owner.read("credential").unwrap();
        let observed_by_b = owner.read("credential").unwrap();
        assert_eq!(observed_by_a, observed_by_b);

        // A swaps first.
        owner.write("credential", "v2-from-a").unwrap();

        // B's compare re-reads custody and must see A's write, not its stale v1: conflict.
        let current_for_b = owner.read("credential").unwrap();
        assert_ne!(current_for_b, observed_by_b);
        assert_eq!(current_for_b, Some("v2-from-a".into()));
        assert_eq!(keychain.items.lock().unwrap().get("credential").cloned(), Some("v2-from-a".into()));

        owner.remove("credential").unwrap();
        assert_eq!(owner.read("credential").unwrap(), None);
        assert_eq!(keychain.items.lock().unwrap().get("credential"), None);
    }

    #[test]
    fn failed_keychain_calls_are_never_cached() {
        let keychain = CountingKeychain::default();
        keychain.items.lock().unwrap().insert("credential".into(), "v1".into());
        let owner = DeviceLocalCustody::new(&keychain);

        *keychain.fail_next_read.lock().unwrap() = true;
        assert!(owner.read("credential").is_err());
        assert_eq!(owner.read("credential").unwrap(), Some("v1".into()));

        *keychain.fail_next_write.lock().unwrap() = true;
        assert!(owner.write("credential", "v2").is_err());
        // The keychain may or may not hold v2 after a failed write; the next read asks it.
        let reads_before = keychain.reads.load(Ordering::SeqCst);
        assert_eq!(owner.read("credential").unwrap(), Some("v1".into()));
        assert_eq!(keychain.reads.load(Ordering::SeqCst), reads_before + 1);
    }

    #[test]
    fn release_keeps_its_service_and_every_other_flavour_gets_its_own() {
        assert_eq!(service_namespace_for_build("dev.happier.app", false), SERVICE_NAMESPACE);
        let services = [
            service_namespace_for_build("dev.happier.app", true),
            service_namespace_for_build("dev.happier.app.preview", false),
            service_namespace_for_build("dev.happier.app.publicdev", false),
            service_namespace_for_build("com.happier.stack.qa-one", false),
            service_namespace_for_build("com.happier.stack.qa-one", true),
        ];
        for (index, service) in services.iter().enumerate() {
            assert_ne!(service, SERVICE_NAMESPACE);
            assert!(service.starts_with(SERVICE_NAMESPACE));
            assert!(!services[index + 1..].contains(service));
        }
    }

    #[test]
    fn scoped_keys_are_stable_opaque_and_domain_separated() {
        let key = opaque_scoped_key("home:https://example.test:token");
        assert_eq!(key.len(), 64);
        assert!(key.chars().all(|value| value.is_ascii_hexdigit()));
        assert!(!key.contains("example"));
        assert_eq!(key, opaque_scoped_key("home:https://example.test:token"));
        assert_ne!(key, opaque_scoped_key("home:https://other.test:token"));
    }

    #[test]
    fn backend_roundtrip_and_idempotent_remove_preserve_command_contract() {
        let backend = MemoryBackend::default();
        assert_eq!(backend.read("key").expect("initial read"), None);
        backend.write("key", "secret").expect("write");
        assert_eq!(
            backend.read("key").expect("readback"),
            Some("secret".to_owned())
        );
        backend.remove("key").expect("remove");
        backend.remove("key").expect("idempotent remove");
        assert_eq!(backend.read("key").expect("removed read"), None);
    }
}
