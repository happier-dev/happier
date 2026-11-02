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
