# Windows Capture &emsp; [![Licence]][Licence URL] [![Build Status]][repository] [![Latest Version]][crates.io] [![Sponsors]][Sponsors URL]

[Licence]: https://img.shields.io/crates/l/windows-capture
[Licence URL]: https://github.com/NiiightmareXD/windows-capture/blob/main/LICENCE
[Build Status]: https://img.shields.io/github/actions/workflow/status/NiiightmareXD/windows-capture/rust.yml
[repository]: https://github.com/NiiightmareXD/windows-capture
[Latest Version]: https://img.shields.io/crates/v/windows-capture
[crates.io]: https://crates.io/crates/windows-capture
[Sponsors]: https://img.shields.io/github/sponsors/NiiightmareXD
[Sponsors URL]: https://github.com/sponsors/NiiightmareXD

## 🎉 Windows Capture 2.0.1 is here! 🚀

- 🎬 Enhanced video encoder: hardware-accelerated with improved stability and monotonic audio timing
- 🖥️ New support for the DXGI Desktop Duplication API

---

**Windows Capture** is a highly efficient Rust and Python library that enables you to capture the screen using the Graphics Capture API effortlessly. This library allows you to easily capture the screen of your Windows-based computer and use it for various purposes, such as creating instructional videos, taking screenshots, or recording your gameplay. With its intuitive interface and robust functionality, Windows Capture is an excellent choice for anyone looking for a reliable, easy-to-use screen-capturing solution.

Note: This README is for the Rust library. The Python library can be found here: https://github.com/NiiightmareXD/windows-capture/tree/main/windows-capture-python

# Recall.ai - API for desktop recording

If you’re looking for a hosted desktop recording API, consider checking out [Recall.ai](https://www.recall.ai/product/desktop-recording-sdk?utm_source=github&utm_medium=sponsorship&utm_campaign=niiightmarexd-windows-capture), an API that records Zoom, Google Meet, Microsoft Teams, in-person meetings, and more.

## Features

- Updates frames only when required
- High performance
- Easy to use
- Uses the latest Windows Graphics Capture API
- Supports the DXGI Desktop Duplication API
- Enhanced, hardware-accelerated video encoder with stable audio timing

## Installation

Add this dependency to your `Cargo.toml`:

```toml
[dependencies]
windows-capture = "2.0.1"
```

Or run this command:

```
cargo add windows-capture
```

## Usage

```rust
use std::io::{self, Write};
use std::time::Instant;

use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::graphics_capture_picker::GraphicsCapturePicker;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

// Handles capture events.
struct Capture {
    // The video encoder that will be used to encode the frames.
    encoder: Option<VideoEncoder>,
    // To measure the time the capture has been running
    start: Instant,
}

impl GraphicsCaptureApiHandler for Capture {
    // The type of flags used to get the values from the settings, here they are the width and height.
    type Flags = (i32, i32);

    // The type of error that can be returned from `CaptureControl` and `start`
    // functions.
    type Error = Box<dyn std::error::Error + Send + Sync>;

    // Function that will be called to create a new instance. The flags can be
    // passed from settings.
    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        // If we didn't want to get the size from the settings, we could use frame.width() and frame.height()
        // in the on_frame_arrived function, but we would need to create the encoder there.
        let encoder = VideoEncoder::new(
            VideoSettingsBuilder::new(ctx.flags.0 as u32, ctx.flags.1 as u32),
            AudioSettingsBuilder::default().disabled(true),
            ContainerSettingsBuilder::default(),
            "video.mp4",
        )?;

        Ok(Self { encoder: Some(encoder), start: Instant::now() })
    }

    // Called every time a new frame is available.
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        print!("\rRecording for: {} seconds", self.start.elapsed().as_secs());
        io::stdout().flush()?;

        // Send the frame to the video encoder
        self.encoder.as_mut().unwrap().send_frame(frame)?;

        // The frame has other uses too, for example, you can save a single frame
        // to a file, like this: frame.save_as_image("frame.png", ImageFormat::Png)?;
        // Or get the raw data like this so you have full control: let data = frame.buffer()?;

        // Stop the capture after 6 seconds
        if self.start.elapsed().as_secs() >= 6 {
            // Finish the encoder and save the video.
            self.encoder.take().unwrap().finish()?;

            capture_control.stop();

            // Because the previous prints did not include a newline.
            println!();
        }

        Ok(())
    }

    // Optional handler called when the capture item (usually a window) is closed.
    fn on_closed(&mut self) -> Result<(), Self::Error> {
        println!("Capture session ended");

        Ok(())
    }
}

fn main() {
    // Opens a dialog to pick a window or screen to capture; refer to the docs for other capture items.
    let item = GraphicsCapturePicker::pick_item().expect("Failed to pick item");

    // If the user canceled the selection, exit.
    let Some(item) = item else {
        println!("No item selected");
        return;
    };

    // Get the size of the item to pass to the settings.
    let size = item.size().expect("Failed to get item size");

    let settings = Settings::new(
        // Item to capture
        item,
        // Capture cursor settings
        CursorCaptureSettings::Default,
        // Draw border settings
        DrawBorderSettings::Default,
        // Secondary window settings, if you want to include secondary windows in the capture
        SecondaryWindowSettings::Default,
        // Minimum interval between eligible updates. This limits the update rate but does not
        // guarantee a constant frame rate. Default leaves the Windows setting unchanged.
        MinimumUpdateIntervalSettings::Default,
        // Dirty region settings
        DirtyRegionSettings::Default,
        // The desired color format for the captured frame.
        ColorFormat::Rgba8,
        // Additional flags for the capture settings that will be passed to the user-defined `new` function.
        size,
    );

    // Starts the capture and takes control of the current thread.
    // The errors from the handler trait will end up here.
    Capture::start(settings).expect("Screen capture failed");
}
```

## Stream-based encoding example

Instead of writing directly to a file, you can encode into an in-memory stream using `VideoEncoder::new_from_stream`. This is useful when you need to send the encoded video over a network, pipe it to another process, or process it further before saving.

```rust
use std::io::{self, Write};
use std::time::Instant;

use windows::Storage::Streams::InMemoryRandomAccessStream;
use windows::core::Interface;
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::graphics_capture_picker::GraphicsCapturePicker;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings,
    SecondaryWindowSettings, Settings,
};

struct StreamCapture {
    encoder: Option<VideoEncoder>,
    stream: InMemoryRandomAccessStream,
    start: Instant,
}

impl GraphicsCaptureApiHandler for StreamCapture {
    type Flags = (i32, i32);
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        // Create an in-memory stream that the encoder will write into.
        // This is useful for scenarios where you want to process the encoded
        // video in memory (e.g., sending it over a network, piping to another
        // process, or performing further transformations) instead of writing
        // directly to a file.
        let stream = InMemoryRandomAccessStream::new()?;

        let encoder = VideoEncoder::new_from_stream(
            VideoSettingsBuilder::new(ctx.flags.0 as u32, ctx.flags.1 as u32),
            AudioSettingsBuilder::default().disabled(true),
            ContainerSettingsBuilder::default(),
            stream.cast()?,
        )?;

        Ok(Self { encoder: Some(encoder), stream, start: Instant::now() })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        print!(
            "\rStreaming for: {} seconds | Buffer size: {} bytes",
            self.start.elapsed().as_secs(),
            self.stream.Size()?
        );
        io::stdout().flush()?;

        self.encoder.as_mut().unwrap().send_frame(frame)?;

        // Stop after 6 seconds and dump the in-memory buffer to a file to prove
        // the stream-based encoder works. In a real application you would read
        // from the stream continuously and forward the bytes elsewhere.
        if self.start.elapsed().as_secs() >= 6 {
            self.encoder.take().unwrap().finish()?;

            let size = self.stream.Size()?;
            println!("\nCapture finished. Stream contains {size} bytes.");

            // Write the in-memory stream to a file as a demonstration.
            let reader = windows::Storage::Streams::DataReader::CreateDataReader(&self.stream.GetInputStreamAt(0)?)?;
            reader.LoadAsync(size as u32)?.join()?;

            let mut bytes = vec![0u8; size as usize];
            reader.ReadBytes(&mut bytes)?;
            std::fs::write("stream_output.mp4", &bytes)?;

            println!("Saved stream to stream_output.mp4");

            capture_control.stop();
        }

        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        println!("Capture session ended");
        Ok(())
    }
}

fn main() {
    let item = GraphicsCapturePicker::pick_item().expect("Failed to pick item");

    let Some(item) = item else {
        println!("No item selected");
        return;
    };

    let size = item.size().expect("Failed to get item size");

    let settings = Settings::new(
        item,
        CursorCaptureSettings::Default,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Rgba8,
        size,
    );

    StreamCapture::start(settings).expect("Stream capture failed");
}
```

## DXGI Desktop Duplication example

```rust
use windows_capture::dxgi_duplication_api::DxgiDuplicationApi;
use windows_capture::encoder::ImageFormat;
use windows_capture::monitor::Monitor;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Select a monitor (primary in this example)
    let monitor = Monitor::primary()?;

    // Create a duplication session for this monitor
    let mut dup = DxgiDuplicationApi::new(monitor)?;

    // Try to grab one frame within ~33ms (about 30 FPS budget)
    let mut frame = dup.acquire_next_frame(33)?;

    // Map the GPU image into CPU memory and save a PNG
    // Note: The API could send an empty frame especially
    // in the first few calls, you can check this by seeing if
    // frame.frame_info().LastPresentTime is zero.
    frame.save_as_image("dxgi_screenshot.png", ImageFormat::Png)?;

    Ok(())
}
```

## Documentation

Detailed documentation for each API and type is available at https://docs.rs/windows-capture.

## Contributing

Contributions are welcome! If you find a bug or want to add a feature, please open an issue or submit a pull request.

## License

This project is licensed under the [MIT License](LICENCE).
