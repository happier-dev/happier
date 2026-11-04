#![cfg(feature = "capture")]
use happier_desktop_native::capture::{files::{CaptureFiles, VideoTiming}, CaptureDisclosure, CaptureError};

const TEXT_OFF: CaptureDisclosure = CaptureDisclosure { has_marks: true, include_window_text: false };

#[test]
fn transparent_window_corners_survive_library_and_prepared_png_storage() {
    use happier_desktop_native::capture::RgbaFrame;
    let root = tempfile::tempdir().unwrap();
    let mut files = CaptureFiles::default();
    let pixels = vec![0, 0, 0, 0, 10, 20, 30, 255, 0, 0, 0, 0,
        10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255,
        0, 0, 0, 0, 10, 20, 30, 255, 0, 0, 0, 0];
    let png = RgbaFrame { width: 3, height: 3, rgba: pixels.clone() }.png().unwrap();
    let capture = files.write_png(root.path(), &png).unwrap();
    let prepared = files.write_prepared_png(&capture.capture_ref, &png, TEXT_OFF).unwrap();
    for path in [&capture.path, &prepared.path] {
        let bytes = std::fs::read(path).unwrap();
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes)).read_info().unwrap();
        let mut decoded = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut decoded).unwrap();
        assert_eq!(info.color_type, png::ColorType::Rgba);
        assert_eq!(decoded, pixels);
        for pixel in [0, 2, 6, 8] { assert_eq!(decoded[pixel * 4 + 3], 0); }
        assert_eq!(decoded[4 * 4 + 3], 255);
    }
}

fn write_video_container(path: &std::path::Path) {
    let config = mp4::Mp4Config { major_brand: "isom".parse().unwrap(), minor_version: 0,
        compatible_brands: vec!["isom".parse().unwrap()], timescale: 1000 };
    let mut writer = mp4::Mp4Writer::write_start(std::fs::File::create(path).unwrap(), &config).unwrap();
    writer.add_track(&mp4::TrackConfig::from(mp4::AvcConfig { width: 16, height: 12,
        seq_param_set: vec![0x67, 0x42, 0, 0x1e], pic_param_set: vec![0x68, 0] })).unwrap();
    // The fixture tests container/sample intake, not codec playback (P4's boundary).
    writer.write_sample(1, &mp4::Mp4Sample { start_time: 0, duration: 1000, rendering_offset: 0,
        is_sync: true, bytes: vec![0, 0, 0, 1, 0x65].into() }).unwrap();
    writer.write_end().unwrap();
}

fn recording_source(files: &mut CaptureFiles, root: &std::path::Path) -> happier_desktop_native::capture::CaptureResult {
    use happier_desktop_native::capture::{CaptureResult, MediaKind, PixelSize};
    let (capture_ref, path) = files.allocate_video(root, happier_desktop_native::capture::recording::Format::Mp4).unwrap();
    // The batch owns file references/bytes, not codec validation; the native writer
    // and physical-trim tests independently exercise playable H.264 output.
    write_video_container(&path);
    files.complete_video(CaptureResult { capture_ref, path, kind: MediaKind::Video,
        mime_type: "video/mp4".into(), byte_size: 0, pixel_size: PixelSize { width: 16, height: 12 },
        scale: None, origin: None, source: None, window_text_ref: None }).unwrap()
}

#[test]
fn prepared_recording_commits_one_batch_of_flattened_refs_and_discard_owns_its_children() {
    use happier_desktop_native::capture::{CancelSignal, RgbaFrame, files::RecordingFrameInput};
    let root = tempfile::tempdir().unwrap();
    let mut files = CaptureFiles::default();
    let source = recording_source(&mut files, root.path());
    let other = recording_source(&mut files, root.path());
    let png = RgbaFrame { width: 2, height: 1, rgba: vec![0, 0, 0, 255, 0, 255, 0, 255] }.png().unwrap();
    let result = files.prepare_recording(&source.capture_ref, vec![
        RecordingFrameInput { time_ms: 0, bytes: png.clone(), note: Some("Retained note".into()) },
        RecordingFrameInput { time_ms: 1000, bytes: png.clone(), note: None },
    ], None, true, TEXT_OFF, &CancelSignal::default()).unwrap();
    assert_eq!(result.capture_ref, source.capture_ref);
    assert_eq!(result.frames.len(), 2, "different selected times survive identical pixels");
    assert_eq!(result.frames[0].note.as_deref(), Some("Retained note"));
    assert_eq!(result.frames[1].time_ms, 1000);
    assert_eq!(result.video_ref.as_deref(), Some(source.capture_ref.as_str()));
    assert_eq!(result.byte_size, source.byte_size + png.len() as u64 * 2);
    assert_eq!(files.prepared_recording(&source.capture_ref).unwrap(), Some(result.clone()));
    let mut frame_paths = Vec::new();
    for frame in &result.frames {
        assert_eq!(files.read_prepared_png(&frame.frame_ref).unwrap(), png);
        let description = files.describe(&frame.frame_ref).unwrap();
        assert_eq!(description.path.parent(), source.path.parent());
        assert_eq!(happier_desktop_native::capture::recents::media_kind(&description.path), None,
            "delivery frames use the existing prepared-output classification, not standalone Recent entries");
        frame_paths.push(description.path);
    }
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 4, "one file per flattened frame, no source copies");
    files.open_media(root.path(), &source.path).unwrap();
    assert_eq!(files.prepared_recording(&source.capture_ref).unwrap(), Some(result),
        "opening a known source retains its in-process prepared batch and derivative ownership");
    files.discard(&source.capture_ref).unwrap();
    assert!(!source.path.exists());
    assert!(frame_paths.iter().all(|path| !path.exists()));
    assert!(other.path.exists(), "discard cannot delete another kept recording");
}

#[test]
fn failed_or_cancelled_recording_replacement_never_exposes_a_partial_or_stale_batch() {
    use happier_desktop_native::capture::{CancelSignal, RgbaFrame, files::RecordingFrameInput};
    let root = tempfile::tempdir().unwrap();
    let mut files = CaptureFiles::default();
    let source = recording_source(&mut files, root.path());
    let unrelated = recording_source(&mut files, root.path());
    let png = RgbaFrame { width: 1, height: 1, rgba: vec![0, 0, 0, 255] }.png().unwrap();
    let frame = || RecordingFrameInput { time_ms: 0, bytes: png.clone(), note: None };
    files.prepare_recording(&source.capture_ref, vec![frame()], None, false, TEXT_OFF, &CancelSignal::default()).unwrap();
    assert_eq!(files.prepare_recording(&source.capture_ref, vec![frame(), RecordingFrameInput {
        time_ms: 1, bytes: b"invalid-png".to_vec(), note: None,
    }], None, false, TEXT_OFF, &CancelSignal::default()), Err(CaptureError::InvalidPng));
    assert_eq!(files.prepared_recording(&source.capture_ref).unwrap(), None);
    assert_eq!(files.disclosure(&source.capture_ref).unwrap(), None);
    assert_eq!(files.prepare_recording(&source.capture_ref, vec![frame()], Some(&unrelated.capture_ref),
        true, TEXT_OFF, &CancelSignal::default()), Err(CaptureError::UnknownCapture));
    let cancelled = CancelSignal::default(); cancelled.cancel();
    assert_eq!(files.prepare_recording(&source.capture_ref, vec![frame()], None, false,
        TEXT_OFF, &cancelled), Err(CaptureError::Cancelled));
    assert_eq!(files.prepared_recording(&source.capture_ref).unwrap(), None);
    files.discard(&source.capture_ref).unwrap();
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1, "failed replacement leaves no orphaned frame");
    assert!(unrelated.path.exists());
}

#[test]
fn prepared_recording_accepts_only_source_or_associated_trim_and_discard_also_removes_failed_trim() {
    use happier_desktop_native::capture::CancelSignal;
    let root = tempfile::tempdir().unwrap();
    let mut files = CaptureFiles::default();
    let source = recording_source(&mut files, root.path());
    let (capture_ref, path) = files.allocate_video_derivative(&source.capture_ref).unwrap();
    std::fs::write(&path, b"trimmed-video").unwrap();
    let movie = files.complete_video(happier_desktop_native::capture::CaptureResult {
        capture_ref, path, byte_size: 0, ..source.clone()
    }).unwrap();
    let disclosure = CaptureDisclosure { has_marks: true, include_window_text: true };
    let prepared = files.prepare_recording(&source.capture_ref, Vec::new(), Some(&movie.capture_ref),
        true, disclosure, &CancelSignal::default()).unwrap();
    assert_eq!(prepared.video_ref.as_deref(), Some(movie.capture_ref.as_str()));
    assert_eq!(prepared.byte_size, movie.byte_size);
    assert_eq!(happier_desktop_native::capture::recents::media_kind(&movie.path), None,
        "a delivery trim is a prepared derivative, not a new Recent recording");
    assert_eq!(happier_desktop_native::capture::recents::media_kind(&source.path),
        Some(happier_desktop_native::capture::MediaKind::Video));
    assert_eq!(files.disclosure(&source.capture_ref).unwrap(), Some(disclosure));
    let (_, partial) = files.allocate_video_derivative(&source.capture_ref).unwrap();
    std::fs::write(&partial, b"incomplete native export").unwrap();
    files.discard(&source.capture_ref).unwrap();
    assert!(!movie.path.exists());
    assert!(!partial.exists());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn recording_edits_invalidate_ready_output_without_losing_source_or_derivative_ownership() {
    use happier_desktop_native::capture::{CancelSignal, RgbaFrame, files::RecordingFrameInput};
    let root = tempfile::tempdir().unwrap();
    let mut files = CaptureFiles::default();
    let source = recording_source(&mut files, root.path());
    let png = RgbaFrame { width: 1, height: 1, rgba: vec![0, 0, 0, 255] }.png().unwrap();
    let prepared = files.prepare_recording(&source.capture_ref, vec![RecordingFrameInput {
        time_ms: 0, bytes: png, note: None,
    }], None, false, TEXT_OFF, &CancelSignal::default()).unwrap();
    let frame = files.describe(&prepared.frames[0].frame_ref).unwrap();
    files.invalidate_recording(&source.capture_ref).unwrap();
    assert_eq!(files.prepared_recording(&source.capture_ref).unwrap(), None);
    assert_eq!(files.disclosure(&source.capture_ref).unwrap(), None);
    assert!(source.path.exists());
    assert!(frame.path.exists(), "editing invalidates delivery, not kept files");
    files.discard(&source.capture_ref).unwrap();
    assert!(!frame.path.exists());
}

#[test]
fn recording_timing_comes_from_the_existing_selected_media_metadata_owner() {
    let root = tempfile::tempdir().unwrap();
    let mut files = CaptureFiles::default();
    let source = recording_source(&mut files, root.path());
    assert_eq!(files.video_timing(&source.capture_ref).unwrap(), VideoTiming { duration_ms: 1000, frame_duration_ms: 1000. });
    assert_eq!(files.video_timing("unknown"), Err(CaptureError::UnknownCapture));
}

#[test]
fn recent_library_reopen_is_in_place_and_external_still_import_is_one_kept_copy() {
    let root = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let original = external.path().join("screenshot.jpg");
    image::RgbImage::from_pixel(3, 2, image::Rgb([12, 34, 56])).save(&original).unwrap();
    let source_bytes = std::fs::read(&original).unwrap();
    let mut files = CaptureFiles::default();
    let imported = files.open_media(root.path(), &original).unwrap();
    assert_eq!(imported.pixel_size.width, 3);
    assert_eq!(happier_desktop_native::capture::recents::media_kind(&imported.path),
        Some(happier_desktop_native::capture::MediaKind::Still), "ordinary kept captures remain discoverable");
    assert_eq!(imported.pixel_size.height, 2);
    assert_eq!(imported.mime_type, "image/png");
    assert_eq!(std::fs::read(&original).unwrap(), source_bytes);
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    drop(files);
    let mut reopened = CaptureFiles::default();
    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::PermissionsExt;
        let original = std::fs::metadata(root.path()).unwrap().permissions();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        original
    };
    let result = reopened.open_media(root.path(), &imported.path);
    #[cfg(unix)]
    std::fs::set_permissions(root.path(), permissions).unwrap();
    let result = result.unwrap(); // Read-only library reopen proves there was no hidden copy.
    assert_eq!(result.path, imported.path);
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1, "library reopen must not copy");
    reopened.discard(&result.capture_ref).unwrap();
    assert!(original.exists());
    let incomplete = external.path().join("writing.mp4");
    std::fs::write(&incomplete, b"unfinished").unwrap();
    assert!(reopened.open_media(root.path(), &incomplete).is_err());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0, "failed import must not publish a kept file");
}

#[test]
fn recent_video_is_kept_once_and_reopens_after_process_lifetime() {
    let library = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let original = external.path().join("recording.mp4");
    write_video_container(&original);
    let original_bytes = std::fs::read(&original).unwrap();
    let mut files = CaptureFiles::default();
    let imported = files.open_media(library.path(), &original).unwrap();
    assert_eq!(imported.kind, happier_desktop_native::capture::MediaKind::Video);
    assert_eq!(imported.mime_type, "video/mp4");
    assert_eq!(imported.pixel_size.width, 16);
    assert_eq!(std::fs::read(&imported.path).unwrap(), original_bytes);
    assert_eq!(std::fs::read(&original).unwrap(), original_bytes);
    drop(files);
    let mut files = CaptureFiles::default();
    assert_eq!(files.open_media(library.path(), &imported.path).unwrap().path, imported.path);
    assert_eq!(std::fs::read_dir(library.path()).unwrap().count(), 1);
    files.discard(&imported.capture_ref).unwrap();
    assert!(original.exists());
}

#[test]
fn recent_webm_reads_the_selected_video_track_before_one_kept_copy() {
    // Minimal EBML container with a video sample. Playback is P4's separate
    // codec boundary; this fixture distinguishes WebM intake from MP4 parsing.
    fn element(id: &[u8], payload: &[u8]) -> Vec<u8> {
        assert!(payload.len() < 127);
        let mut bytes = id.to_vec(); bytes.push(0x80 | payload.len() as u8); bytes.extend(payload); bytes
    }
    let mut header = Vec::new();
    for (id, value) in [(vec![0x42, 0x86], vec![1]), (vec![0x42, 0xf7], vec![1]),
        (vec![0x42, 0xf2], vec![4]), (vec![0x42, 0xf3], vec![8]),
        (vec![0x42, 0x82], b"webm".to_vec()), (vec![0x42, 0x87], vec![4]), (vec![0x42, 0x85], vec![2])] {
        header.extend(element(&id, &value));
    }
    // Two milliseconds per tick distinguishes encoded ticks from nanoseconds.
    let mut info = element(&[0x2a, 0xd7, 0xb1], &[0x1e, 0x84, 0x80]);
    info.extend(element(&[0x44, 0x89], &1000.0_f64.to_be_bytes()));
    info.extend(element(&[0x4d, 0x80], b"fixture"));
    info.extend(element(&[0x57, 0x41], b"fixture"));
    let mut track = element(&[0xd7], &[1]);
    track.extend(element(&[0x73, 0xc5], &[1])); track.extend(element(&[0x83], &[1]));
    track.extend(element(&[0x86], b"V_VP9"));
    let mut video = element(&[0xb0], &[16]); video.extend(element(&[0xba], &[12]));
    track.extend(element(&[0xe0], &video));
    let mut cluster = element(&[0xe7], &[0]);
    cluster.extend(element(&[0xa3], &[0x81, 0, 0, 0x80, 0x82, 0x49, 0x83, 0x42]));
    // No guessed fps: a second encoded timestamp 50 ticks later is one 100ms frame.
    cluster.extend(element(&[0xa3], &[0x81, 0, 50, 0x80, 0x82, 0x49, 0x83, 0x42]));
    let mut bytes = element(&[0x1a, 0x45, 0xdf, 0xa3], &header);
    bytes.extend([0x18, 0x53, 0x80, 0x67, 0xff]); // Segment, unknown stream size.
    bytes.extend(element(&[0x15, 0x49, 0xa9, 0x66], &info));
    bytes.extend(element(&[0x16, 0x54, 0xae, 0x6b], &element(&[0xae], &track)));
    bytes.extend(element(&[0x1f, 0x43, 0xb6, 0x75], &cluster));
    let external = tempfile::tempdir().unwrap();
    let library = tempfile::tempdir().unwrap();
    let original = external.path().join("recording.webm"); std::fs::write(&original, &bytes).unwrap();
    let mut files = CaptureFiles::default();
    let imported = files.open_media(library.path(), &original).unwrap();
    assert_eq!(imported.mime_type, "video/webm");
    assert_eq!(imported.pixel_size.width, 16);
    assert_eq!(imported.pixel_size.height, 12);
    assert_eq!(files.video_timing(&imported.capture_ref).unwrap(), VideoTiming { duration_ms: 2000, frame_duration_ms: 100. });
    assert_eq!(std::fs::read(&imported.path).unwrap(), bytes);
    assert_eq!(std::fs::read(&original).unwrap(), bytes);
    assert_eq!(files.open_media(library.path(), &imported.path).unwrap().path, imported.path);
    assert_eq!(std::fs::read_dir(library.path()).unwrap().count(), 1);
}

fn png(marker: u8) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 2, 1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().unwrap().write_image_data(&[marker, 0, 0, 255, 0, marker, 0, 255]).unwrap();
    }
    bytes
}

#[test]
fn retained_prepared_pixels_survive_new_exports_and_parent_discard() {
    let root = tempfile::tempdir().unwrap();
    let mut files = CaptureFiles::default();
    let source = files.write_png(root.path(), &png(1)).unwrap();
    files.write_prepared_png(&source.capture_ref, &png(11), TEXT_OFF).unwrap();
    let retained = files.retain_prepared_png(&source.capture_ref).unwrap();
    files.write_prepared_png(&source.capture_ref, &png(22), TEXT_OFF).unwrap();
    assert_eq!(std::fs::read(&retained.path).unwrap(), png(11), "draft pixels must not follow later edits");
    assert_eq!(files.read_source_png(&retained.capture_ref).unwrap(), png(11));
    files.discard(&source.capture_ref).unwrap();
    assert_eq!(std::fs::read(&retained.path).unwrap(), png(11), "discarding the editor must keep draft pixels");
    assert_eq!(files.read_source_png(&retained.capture_ref).unwrap(), png(11));
}

#[test]
fn prepared_pixels_are_kept_beside_source_and_discard_only_removes_owned_files() {
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let original = other.path().join("original.png");
    std::fs::write(&original, png(7)).unwrap();
    let mut files = CaptureFiles::default();
    let source = files.import_png(root.path(), &original).unwrap();
    let prepared = files.write_prepared_png(&source.capture_ref, &png(99), TEXT_OFF).unwrap();
    assert_eq!(files.disclosure(&source.capture_ref).unwrap(), Some(TEXT_OFF));
    assert_eq!(source.path.parent(), prepared.path.parent());
    assert_eq!(files.read_prepared_png(&source.capture_ref).unwrap(), png(99));
    let included = CaptureDisclosure { has_marks: true, include_window_text: true };
    files.write_prepared_png(&source.capture_ref, &png(42), included).unwrap();
    assert_eq!(files.read_prepared_png(&source.capture_ref).unwrap(), png(42));
    drop(files);
    assert!(source.path.exists());
    assert!(prepared.path.exists());
    let mut reopened = CaptureFiles::default();
    let retained = reopened.open_library_png(root.path(), &source.path).unwrap();
    assert_eq!(retained.path, source.path);
    assert_eq!(reopened.disclosure(&retained.capture_ref).unwrap(), Some(included));
    assert_eq!(reopened.read_prepared_png(&retained.capture_ref).unwrap(), png(42));
    reopened.discard(&retained.capture_ref).unwrap();
    assert!(!source.path.exists());
    assert!(!prepared.path.exists());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0, "discard owns the disclosure sidecar too");
    assert!(original.exists());
}

#[test]
fn unknown_or_failed_prepared_write_never_returns_source_pixels() {
    let root = tempfile::tempdir().unwrap();
    let mut files = CaptureFiles::default();
    assert_eq!(files.read_prepared_png("unknown").unwrap_err(), CaptureError::UnknownCapture);
    let source = files.write_png(root.path(), &png(1)).unwrap();
    assert_eq!(files.read_prepared_png(&source.capture_ref).unwrap_err(), CaptureError::PreparedMissing);
    assert!(files.write_prepared_png(&source.capture_ref, b"not png", TEXT_OFF).is_err());
    assert_eq!(files.read_prepared_png(&source.capture_ref).unwrap_err(), CaptureError::PreparedMissing);
    files.write_prepared_png(&source.capture_ref, &png(9), TEXT_OFF).unwrap();
    assert!(files.write_prepared_png(&source.capture_ref, b"invalid newer export", TEXT_OFF).is_err());
    assert_eq!(files.read_prepared_png(&source.capture_ref).unwrap_err(), CaptureError::PreparedMissing);
    assert_eq!(files.disclosure(&source.capture_ref).unwrap(), None);
    let mut reopened = CaptureFiles::default();
    reopened.open_library_png(root.path(), &source.path).unwrap();
    assert_eq!(reopened.disclosure(&source.capture_ref).unwrap(), None);
    assert_eq!(reopened.read_prepared_png(&source.capture_ref).unwrap_err(), CaptureError::PreparedMissing,
        "a failed newer export must not resurrect the prior prepared pixels on reopen");
    files.discard(&source.capture_ref).unwrap();
    let source = files.write_png(root.path(), &png(1)).unwrap();
    std::fs::remove_file(&source.path).unwrap();
    std::fs::remove_dir(root.path()).unwrap();
    assert!(files.write_prepared_png(&source.capture_ref, &png(3), TEXT_OFF).is_err());
}

#[test]
fn unfinished_video_is_discardable_but_never_a_completed_media_result() {
    let root = tempfile::tempdir().unwrap();
    let mut files = CaptureFiles::default();
    let (capture_ref, path) = files.allocate_video(root.path(), happier_desktop_native::capture::recording::Format::Mp4).unwrap();
    std::fs::write(&path, b"incomplete encoder output").unwrap();
    assert!(files.describe(&capture_ref).is_err(), "partial bytes are not playable/ready media");
    files.discard(&capture_ref).unwrap();
    assert!(!path.exists());
}

#[test]
fn webm_trim_allocation_preserves_the_sources_container_and_discard_ownership() {
    use happier_desktop_native::capture::{CaptureResult, MediaKind, PixelSize};
    let root = tempfile::tempdir().unwrap();
    let mut files = CaptureFiles::default();
    let (capture_ref, path) = files.allocate_video(root.path(), happier_desktop_native::capture::recording::Format::Webm).unwrap();
    assert_eq!(path.extension().unwrap(), "webm");
    // File ownership does not decode; the Linux native pipeline owns codec proof.
    std::fs::write(&path, b"finalized WebM boundary output").unwrap();
    files.complete_video(CaptureResult { capture_ref: capture_ref.clone(), path: path.clone(),
        kind: MediaKind::Video, mime_type: "video/webm".into(), byte_size: 0,
        pixel_size: PixelSize { width: 16, height: 12 }, scale: None, origin: None,
        source: None, window_text_ref: None }).unwrap();
    let (_, derivative) = files.allocate_video_derivative(&capture_ref).unwrap();
    assert_eq!(derivative.extension().unwrap(), "webm", "physical trim must keep the source container");
    std::fs::write(&derivative, b"failed partial trim").unwrap();
    files.discard(&capture_ref).unwrap();
    assert!(!path.exists());
    assert!(!derivative.exists());
}
