//! Metadata-only recent captures. The picker owns the watch lifetime.
use super::MediaKind;
use notify::{event::{AccessKind, AccessMode}, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{collections::{BTreeMap, BTreeSet}, fs, path::{Path, PathBuf}, sync::{Arc, Mutex}, time::UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: PathBuf,
    pub name: String,
    pub kind: MediaKind,
    pub byte_size: u64,
    pub modified_at: Option<u64>,
    pub modified_at_nanos: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFolder {
    pub path: PathBuf,
    pub issue: Option<FolderIssue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderIssue { Missing, Denied, ReadFailed, WatchUnavailable }

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSnapshot {
    pub entries: Vec<Arc<RecentEntry>>,
    pub folders: Vec<RecentFolder>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentChanges {
    pub upserted: Vec<Arc<RecentEntry>>,
    pub removed: Vec<PathBuf>,
    pub folders: Option<Vec<RecentFolder>>,
    pub reconciled: bool,
}

#[derive(Default)]
struct Index {
    active: bool,
    roots: Vec<PathBuf>,
    entries: BTreeMap<PathBuf, Arc<RecentEntry>>,
    folders: Vec<RecentFolder>,
    watch_failures: BTreeSet<PathBuf>,
    #[cfg(test)]
    directory_reads: usize,
    #[cfg(test)]
    metadata_reads: usize,
}

impl Index {
    fn scan(&mut self) -> RecentChanges {
        if !self.active { return RecentChanges::default(); }
        let mut changes = RecentChanges { reconciled: true, ..RecentChanges::default() };
        let old_folders = self.folders.clone();
        self.folders.clear();
        for root in self.roots.clone() { self.scan_folder(&root, &mut changes); }
        if self.folders != old_folders { changes.folders = Some(self.folders.clone()); }
        changes
    }
    fn scan_folder(&mut self, root: &Path, changes: &mut RecentChanges) {
        #[cfg(test)] { self.directory_reads += 1; }
        let mut present = BTreeSet::new();
        let issue = match fs::read_dir(root) {
            Ok(entries) => {
                let mut issue = None;
                for entry in entries {
                    match entry {
                        Ok(entry) => {
                            let path = entry.path();
                            present.insert(path.clone());
                            self.update_path(&path, changes);
                        },
                        Err(error) => { issue = Some(folder_issue(&error)); }
                    }
                }
                issue
            },
            Err(error) => Some(folder_issue(&error)),
        };
        // Retain readable history after a denied/failed read; missing directories
        // really withdrew their entries and explicit Refresh/reopen recovers them.
        if issue.is_none() || issue == Some(FolderIssue::Missing) {
            let removed: Vec<_> = self.entries.keys().filter(|path| path.parent() == Some(root) && !present.contains(*path)).cloned().collect();
            for path in removed { self.entries.remove(&path); changes.removed.push(path); }
        }
        let issue = issue.or_else(|| self.watch_failures.contains(root).then_some(FolderIssue::WatchUnavailable));
        self.folders.push(RecentFolder { path: root.to_path_buf(), issue });
    }
    fn update_path(&mut self, path: &Path, changes: &mut RecentChanges) {
        let Some(kind) = media_kind(path) else { return; };
        #[cfg(test)] { self.metadata_reads += 1; }
        match fs::metadata(path) {
            Ok(metadata) if metadata.is_file() => {
                let modified = metadata.modified().ok().and_then(|date| date.duration_since(UNIX_EPOCH).ok());
                let next = RecentEntry { path: path.to_path_buf(), name: path.file_name().unwrap().to_string_lossy().into_owned(),
                    kind, byte_size: metadata.len(), modified_at: modified.and_then(|date| date.as_millis().try_into().ok()),
                    modified_at_nanos: modified.map(|date| date.as_nanos().to_string()) };
                if self.entries.get(path).is_some_and(|old| **old == next) { return; }
                let next = Arc::new(next);
                self.entries.insert(path.to_path_buf(), next.clone());
                changes.upserted.push(next);
            },
            Ok(_) => { if self.entries.remove(path).is_some() { changes.removed.push(path.to_path_buf()); } },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if self.entries.remove(path).is_some() { changes.removed.push(path.to_path_buf()); }
            },
            // A partial/denied stat doesn't erase a previously readable row.
            Err(_) => {},
        }
    }
    fn paths_changed(&mut self, paths: &[PathBuf]) -> RecentChanges {
        if !self.active { return RecentChanges::default(); }
        if paths.iter().any(|path| self.roots.contains(path)) { return self.scan(); }
        let mut changes = RecentChanges::default();
        for path in paths.iter().collect::<BTreeSet<_>>() {
            if path.parent().is_some_and(|parent| self.roots.iter().any(|root| root == parent)) {
                self.update_path(path, &mut changes);
            }
        }
        changes
    }
    fn event(&mut self, event: notify::Result<Event>) -> RecentChanges {
        if !self.active { return RecentChanges::default(); }
        match event {
            Ok(event) if event.need_rescan() || matches!(event.kind, EventKind::Any | EventKind::Other) => self.scan(),
            Ok(event) if matches!(event.kind, EventKind::Access(AccessKind::Close(AccessMode::Write))) => self.paths_changed(&event.paths),
            // Our metadata/body reads are not writes and must never feed the watcher.
            Ok(event) if matches!(event.kind, EventKind::Access(_)) => RecentChanges::default(),
            Ok(event) => self.paths_changed(&event.paths),
            Err(_) => self.scan(),
        }
    }
    fn snapshot(&self) -> RecentSnapshot {
        RecentSnapshot { entries: self.entries.values().cloned().collect(), folders: self.folders.clone() }
    }
}

fn folder_issue(error: &std::io::Error) -> FolderIssue {
    match error.kind() { std::io::ErrorKind::NotFound => FolderIssue::Missing,
        std::io::ErrorKind::PermissionDenied => FolderIssue::Denied, _ => FolderIssue::ReadFailed }
}

pub fn media_kind(path: &Path) -> Option<MediaKind> {
    let stem = path.file_stem()?.to_str()?;
    if stem.starts_with("capture-") && stem.ends_with("-prepared") { return None; }
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif" | "tif" | "tiff" => Some(MediaKind::Still),
        "mp4" | "mov" | "webm" => Some(MediaKind::Video),
        _ => None,
    }
}

fn canonical_roots(roots: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = BTreeSet::new();
    roots.into_iter().map(|path| path.canonicalize().unwrap_or(path)).filter(|path| seen.insert(path.clone())).collect()
}

impl RecentChanges {
    fn changed(&self) -> bool { !self.upserted.is_empty() || !self.removed.is_empty() || self.folders.is_some() }
}

type Publisher = Arc<dyn Fn(RecentChanges) + Send + Sync>;
#[derive(Default)]
pub struct RecentCaptures {
    index: Arc<Mutex<Index>>,
    watcher: Option<RecommendedWatcher>,
    publisher: Option<Publisher>,
}
impl RecentCaptures {
    pub fn list(roots: Vec<PathBuf>) -> RecentSnapshot {
        let mut index = Index { active: true, roots: canonical_roots(roots), ..Index::default() };
        index.scan(); index.snapshot()
    }
    pub fn is_open(&self) -> bool { self.index.lock().unwrap().active }
    pub fn snapshot(&self) -> RecentSnapshot { self.index.lock().unwrap().snapshot() }
    pub fn open(&mut self, roots: Vec<PathBuf>, publish: Publisher) -> RecentSnapshot {
        if self.is_open() { self.replace_folders(roots); return self.snapshot(); }
        {
            let mut index = self.index.lock().unwrap();
            *index = Index { active: true, roots: canonical_roots(roots), ..Index::default() };
        }
        let index = self.index.clone();
        let callback = publish.clone();
        self.watcher = notify::recommended_watcher(move |event| {
            let mut index = index.lock().unwrap();
            let changes = index.event(event);
            if changes.changed() { callback(changes); }
        }).ok();
        // Register before enumerating: writes during initial load are retained as
        // changed-path events. No polling fallback is installed for absent watches.
        let roots = self.index.lock().unwrap().roots.clone();
        let watch_failures = roots.iter().filter(|root| self.watch(root).is_err()).cloned().collect();
        let mut index = self.index.lock().unwrap();
        index.watch_failures = watch_failures;
        index.scan();
        self.publisher = Some(publish);
        index.snapshot()
    }
    fn watch(&mut self, path: &Path) -> notify::Result<()> {
        self.watcher.as_mut().ok_or_else(|| notify::Error::generic("native watcher unavailable"))?.watch(path, RecursiveMode::NonRecursive)
    }
    pub fn refresh(&mut self) -> RecentSnapshot {
        if !self.is_open() { return self.snapshot(); }
        let failures = self.index.lock().unwrap().watch_failures.clone();
        for root in failures {
            if self.watch(&root).is_ok() { self.index.lock().unwrap().watch_failures.remove(&root); }
        }
        let mut index = self.index.lock().unwrap();
        let changes = index.scan();
        if changes.changed() { if let Some(publish) = &self.publisher { publish(changes); } }
        index.snapshot()
    }
    /// Reconfigure only actual folder demand. A closed picker does no work.
    pub fn replace_folders(&mut self, roots: Vec<PathBuf>) {
        if !self.is_open() { return; }
        let roots = canonical_roots(roots);
        let previous = self.index.lock().unwrap().roots.clone();
        if previous == roots { return; }
        let removed: Vec<_> = previous.iter().filter(|root| !roots.contains(root)).cloned().collect();
        let added: Vec<_> = roots.iter().filter(|root| !previous.contains(root)).cloned().collect();
        for root in &removed { if let Some(watcher) = &mut self.watcher { let _ = watcher.unwatch(root); } }
        let watch_failures: Vec<_> = added.iter().filter(|root| self.watch(root).is_err()).cloned().collect();
        let mut index = self.index.lock().unwrap();
        for root in &removed { index.watch_failures.remove(root); }
        index.watch_failures.extend(watch_failures);
        let mut changes = RecentChanges::default();
        let deleted: Vec<_> = index.entries.keys().filter(|path| path.parent().is_some_and(|parent| removed.iter().any(|root| root == parent))).cloned().collect();
        for path in deleted { index.entries.remove(&path); changes.removed.push(path); }
        index.folders.retain(|folder| !removed.contains(&folder.path));
        index.roots = roots;
        for root in &added { index.scan_folder(root, &mut changes); }
        changes.folders = Some(index.folders.clone());
        if let Some(publish) = &self.publisher { publish(changes); }
    }
    pub fn close(&mut self) {
        self.index.lock().unwrap().active = false;
        self.watcher = None;
        self.publisher = None;
        let mut index = self.index.lock().unwrap();
        index.entries.clear(); index.folders.clear(); index.roots.clear(); index.watch_failures.clear();
    }
}
impl Drop for RecentCaptures { fn drop(&mut self) { self.close(); } }

/// Known Folders/XDG and Apple's documented screenshot preference are the only
/// automatic destinations. Other tools' folders are explicit picker demand.
pub fn destinations(library: PathBuf, selected: Option<PathBuf>) -> Vec<PathBuf> {
    let mut roots = vec![library];
    #[cfg(target_os = "macos")]
    if let Some(folder) = screenshot_destination().or_else(dirs::desktop_dir) { roots.push(folder); }
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Shell::{FOLDERID_AppCaptures, FOLDERID_Screenshots};
        if let Some(screenshots) = known_folder(&FOLDERID_Screenshots) { add_known_destination(&mut roots, screenshots); }
        if let Some(captures) = known_folder(&FOLDERID_AppCaptures) { add_known_destination(&mut roots, captures); }
        if let Some(videos) = dirs::video_dir() { add_known_destination(&mut roots, videos.join("Screen Recordings")); }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(pictures) = dirs::picture_dir() { add_known_destination(&mut roots, pictures.join("Screenshots")); }
        if let Some(videos) = dirs::video_dir() { add_known_destination(&mut roots, videos.join("Screencasts")); }
    }
    if let Some(selected) = selected { roots.push(selected); }
    canonical_roots(roots)
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn add_known_destination(roots: &mut Vec<PathBuf>, path: PathBuf) {
    // An absent OS tool folder is ordinary, not an error card. Preserve denied
    // and unreadable destinations so the picker can show their recovery state.
    if !matches!(fs::metadata(&path), Err(error) if error.kind() == std::io::ErrorKind::NotFound) { roots.push(path); }
}

#[cfg(target_os = "windows")]
fn known_folder(id: &windows::core::GUID) -> Option<PathBuf> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    use windows::Win32::{System::Com::CoTaskMemFree, UI::Shell::{SHGetKnownFolderPath, KF_FLAG_DONT_VERIFY}};
    // DONT_VERIFY reads redirected Known Folder configuration without creating it.
    unsafe {
        let value = SHGetKnownFolderPath(id, KF_FLAG_DONT_VERIFY, None).ok()?;
        let path = PathBuf::from(OsString::from_wide(value.as_wide()));
        CoTaskMemFree(Some(value.0.cast()));
        Some(path)
    }
}

#[cfg(target_os = "macos")]
fn screenshot_destination() -> Option<PathBuf> {
    use objc2::AnyThread;
    use objc2_foundation::{NSString, NSUserDefaults};
    // Read-only preference access; path expansion belongs to Foundation.
    let defaults = NSUserDefaults::initWithSuiteName(NSUserDefaults::alloc(), Some(&NSString::from_str("com.apple.screencapture")))?;
    let location = defaults.stringForKey(&NSString::from_str("location"))?;
    Some(PathBuf::from(location.stringByExpandingTildeInPath().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind, RenameMode};
    use std::fs;
    fn watched_folder() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("target");
        fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }

    #[test]
    fn metadata_listing_and_notify_batches_preserve_rows_and_changed_path_costs() {
        let root = tempfile::tempdir().unwrap();
        // Intentionally invalid media: listing must not decode/read bodies.
        for n in 0..1000 {
            let suffix = match n % 4 { 0 => "png", 1 => "mp4", 2 => "jpg", _ => "txt" };
            fs::write(root.path().join(format!("item-{n:04}.{suffix}")), b"metadata only").unwrap();
        }
        fs::write(root.path().join("capture-abc-prepared.png"), b"not a separate capture").unwrap();
        let mut index = Index { active: true, roots: vec![root.path().to_path_buf()], ..Index::default() };
        let first = index.scan();
        assert_eq!(first.upserted.len(), 750, "open must list all supported media without decoding");
        assert_eq!(index.directory_reads, 1);
        let stable = index.entries[&root.path().join("item-0000.png")].clone();
        let unchanged = index.scan();
        assert!(!unchanged.changed(), "an equal read must not request publication");
        assert!(Arc::ptr_eq(&stable, &index.entries[&stable.path]));
        let before_dirs = index.directory_reads;
        let before_stats = index.metadata_reads;
        let changed = root.path().join("item-0001.mp4");
        fs::write(&changed, b"updated media body").unwrap();
        let write_batch = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any)))
            .add_path(changed.clone()).add_path(changed.clone());
        let delta = index.event(Ok(write_batch.clone()));
        assert_eq!(delta.upserted.len(), 1);
        assert_eq!(delta.upserted[0].path, changed);
        assert_eq!(index.directory_reads, before_dirs, "a file event must not enumerate the folder");
        assert_eq!(index.metadata_reads - before_stats, 1, "one changed path needs one metadata read");
        assert!(Arc::ptr_eq(&stable, &index.entries[&stable.path]));
        assert!(!index.event(Ok(write_batch)).changed(), "equal event batches must not request publication");
        let created = root.path().join("created.png");
        fs::write(&created, b"new still").unwrap();
        let before = (index.directory_reads, index.metadata_reads);
        let delta = index.event(Ok(Event::new(EventKind::Create(CreateKind::File)).add_path(created.clone())));
        assert_eq!(delta.upserted[0].path, created);
        assert_eq!((index.directory_reads, index.metadata_reads), (before.0, before.1 + 1));
        let renamed = root.path().join("renamed.mp4");
        fs::rename(&changed, &renamed).unwrap();
        let rename_batch = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(changed.clone()).add_path(renamed.clone());
        let before = (index.directory_reads, index.metadata_reads);
        let delta = index.event(Ok(rename_batch.clone()));
        assert_eq!(delta.removed, vec![changed]);
        assert_eq!(delta.upserted[0].path, renamed);
        assert_eq!((index.directory_reads, index.metadata_reads), (before.0, before.1 + 2));
        assert!(!index.event(Ok(rename_batch)).changed(), "repeated rename delivery must not republish");
        fs::remove_file(&created).unwrap();
        let remove_batch = Event::new(EventKind::Remove(RemoveKind::File))
            .add_path(created.clone()).add_path(created.clone());
        let before = (index.directory_reads, index.metadata_reads);
        let delta = index.event(Ok(remove_batch.clone()));
        assert_eq!(delta.removed, vec![created]);
        assert_eq!((index.directory_reads, index.metadata_reads), (before.0, before.1 + 1));
        assert!(!index.event(Ok(remove_batch)).changed());
        let previous_modified = fs::metadata(&renamed).unwrap().modified().unwrap();
        let previous_row = index.entries[&renamed].clone();
        fs::write(&renamed, b"final closed write").unwrap();
        // Equal-size writes need not advance the filesystem timestamp. Recents
        // observes metadata only, so unchanged metadata must retain the row.
        fs::File::options().write(true).open(&renamed).unwrap().set_modified(previous_modified).unwrap();
        let before = (index.directory_reads, index.metadata_reads);
        let read = index.event(Ok(Event::new(EventKind::Access(AccessKind::Close(AccessMode::Read))).add_path(renamed.clone())));
        assert!(!read.changed());
        assert_eq!((index.directory_reads, index.metadata_reads), before, "read notifications must not feed metadata reads");
        let delta = index.event(Ok(Event::new(EventKind::Access(AccessKind::Close(AccessMode::Write))).add_path(renamed.clone())));
        assert!(!delta.changed(), "equal metadata must not request publication");
        assert!(Arc::ptr_eq(&previous_row, &index.entries[&renamed]), "equal metadata must retain the existing row");
        assert_eq!((index.directory_reads, index.metadata_reads), (before.0, before.1 + 1));
        // A distinct size guarantees a real metadata change without waiting for
        // the filesystem clock to advance.
        let final_body = b"final closed write with changed size";
        fs::write(&renamed, final_body).unwrap();
        let before = (index.directory_reads, index.metadata_reads);
        let delta = index.event(Ok(Event::new(EventKind::Access(AccessKind::Close(AccessMode::Write))).add_path(renamed.clone())));
        assert_eq!(delta.upserted.len(), 1);
        assert_eq!(delta.upserted[0].path, renamed);
        assert_eq!(delta.upserted[0].byte_size, final_body.len() as u64);
        assert_eq!((index.directory_reads, index.metadata_reads), (before.0, before.1 + 1));
        let missed = root.path().join("missed.webp");
        fs::write(&missed, b"a native event may be coalesced or delayed").unwrap();
        let before_gap = index.directory_reads;
        let gap = index.event(Ok(Event::new(EventKind::Other)));
        assert!(gap.reconciled);
        assert_eq!(index.directory_reads - before_gap, 1, "an unknown OS gap permits one full reconciliation");
        assert_eq!(gap.upserted[0].path, missed);
        assert!(Arc::ptr_eq(&stable, &index.entries[&stable.path]), "gap reconciliation must preserve unchanged rows");
        assert!(!index.event(Ok(Event::new(EventKind::Other))).changed(), "an equal reconciliation must not republish");
        index.active = false;
        let before = (index.directory_reads, index.metadata_reads);
        fs::remove_file(&renamed).unwrap();
        let closed = index.event(Ok(Event::new(EventKind::Remove(RemoveKind::File)).add_path(renamed)));
        assert!(!closed.changed());
        assert!(!index.event(Ok(Event::new(EventKind::Other))).changed());
        assert!(index.scan().upserted.is_empty());
        assert_eq!((index.directory_reads, index.metadata_reads), before, "closed means zero work");
        index.active = true;
        assert_eq!(index.scan().removed.len(), 1, "reopen must reflect changes while closed");
    }

    #[test]
    fn unreadable_folder_does_not_hide_readable_media() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("okay.png"), b"not decoded").unwrap();
        let not_a_folder = root.path().join("not-a-folder");
        fs::write(&not_a_folder, b"x").unwrap();
        let mut index = Index { active: true, roots: vec![not_a_folder, root.path().to_path_buf(), root.path().join("absent")], ..Index::default() };
        index.scan();
        assert_eq!(index.entries.len(), 1);
        assert_eq!(index.folders.len(), 3);
        assert!(index.folders[0].issue.is_some());
        assert_eq!(index.folders[1].issue, None);
        assert_eq!(index.folders[2].issue, Some(FolderIssue::Missing));
    }

    #[test]
    fn native_created_file_smoke() {
        let root = watched_folder();
        let root_path = root.path().canonicalize().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut recent = RecentCaptures::default();
        let snapshot = recent.open(vec![root.path().to_path_buf()], Arc::new(move |delta| { sender.send(delta).unwrap(); }));
        assert!(snapshot.entries.is_empty());
        assert_eq!(snapshot.folders[0].issue, None);
        let created = root_path.join("created.mp4");
        fs::write(&created, b"closed-write event").unwrap();
        loop {
            let delta = receiver.recv_timeout(std::time::Duration::from_secs(30)).expect("native create/close-write notification");
            if delta.upserted.iter().any(|row| row.path == created) { break; }
        }
        recent.close();
    }

    #[test]
    fn explicitly_selected_folder_is_ephemeral_and_deduplicated_with_the_library() {
        let root = tempfile::tempdir().unwrap();
        let selected = tempfile::tempdir().unwrap();
        let roots = destinations(root.path().to_path_buf(), Some(selected.path().to_path_buf()));
        assert!(roots.contains(&selected.path().canonicalize().unwrap()));
        let roots = destinations(root.path().to_path_buf(), Some(root.path().join(".")));
        assert_eq!(roots.iter().filter(|path| **path == root.path().canonicalize().unwrap()).count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn denied_folder_beside_readable_folder_is_a_visible_issue() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let denied = root.path().join("denied");
        fs::create_dir(&denied).unwrap();
        fs::write(root.path().join("okay.png"), b"metadata").unwrap();
        fs::set_permissions(&denied, fs::Permissions::from_mode(0o000)).unwrap();
        let mut index = Index { active: true, roots: vec![denied.clone(), root.path().to_path_buf()], ..Index::default() };
        index.scan();
        fs::set_permissions(&denied, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(index.folders[0].issue, Some(FolderIssue::Denied));
        assert_eq!(index.entries.len(), 1);
    }

    #[test]
    fn refresh_reconciles_a_previously_missing_folder_and_reopen_reads_closed_changes() {
        let root = watched_folder();
        let folder = root.path().canonicalize().unwrap().join("not-yet-created");
        let mut recent = RecentCaptures::default();
        let snapshot = recent.open(vec![folder.clone()], Arc::new(|_| {}));
        assert_eq!(snapshot.folders[0].issue, Some(FolderIssue::Missing));
        fs::create_dir(&folder).unwrap();
        let path = folder.join("found-by-refresh.png");
        fs::write(&path, b"metadata").unwrap();
        let snapshot = recent.refresh();
        assert_eq!(snapshot.folders[0].issue, None, "Refresh must retry native registration");
        assert_eq!(snapshot.entries[0].path, path, "explicit Refresh recovers without waiting for native delivery");
        assert!(recent.index.lock().unwrap().watch_failures.is_empty());
        recent.close();
        fs::remove_file(&path).unwrap();
        let created_while_closed = folder.join("found-on-reopen.mp4");
        fs::write(&created_while_closed, b"metadata").unwrap();
        let snapshot = recent.open(vec![folder], Arc::new(|_| {}));
        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(snapshot.entries[0].path, created_while_closed);
        recent.close();
    }

    #[test]
    fn folder_demand_changes_enumerate_only_added_folders_and_closed_changes_do_no_work() {
        let first = watched_folder();
        let second = watched_folder();
        fs::write(first.path().join("stable.png"), b"metadata").unwrap();
        fs::write(second.path().join("new.png"), b"metadata").unwrap();
        let publications = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = publications.clone();
        let mut recent = RecentCaptures::default();
        let first_root = first.path().canonicalize().unwrap();
        let second_root = second.path().canonicalize().unwrap();
        recent.open(vec![first_root.clone()], Arc::new(move |_| { count.fetch_add(1, std::sync::atomic::Ordering::SeqCst); }));
        let stable = recent.snapshot().entries[0].clone();
        let before = recent.index.lock().unwrap().directory_reads;
        recent.replace_folders(vec![first_root.clone(), second_root]);
        assert_eq!(recent.index.lock().unwrap().directory_reads - before, 1);
        assert!(Arc::ptr_eq(&stable, &recent.index.lock().unwrap().entries[&stable.path]));
        assert_eq!(publications.load(std::sync::atomic::Ordering::SeqCst), 1);
        recent.refresh();
        assert_eq!(publications.load(std::sync::atomic::Ordering::SeqCst), 1, "unchanged refresh must not publish");
        recent.close();
        let before = recent.index.lock().unwrap().directory_reads;
        recent.replace_folders(vec![first_root]);
        recent.refresh();
        assert_eq!(recent.index.lock().unwrap().directory_reads, before);
    }
}
