use std::io::{self, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use clap::Parser;
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, GraphicsCaptureItemType,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

/// Holds the settings for the capture session, provided from the command line.
struct CaptureSettings {
    /// A flag to signal the capture thread to stop.
    stop_flag: Arc<AtomicBool>,
    /// The width of the video frame.
    width: u32,
    /// The height of the video frame.
    height: u32,
    /// The path to the output video file.
    path: String,
    /// The bitrate of the video, in bits per second.
    bitrate: u32,
    /// The frame rate of the video, in frames per second.
    frame_rate: u32,
}

/// This struct handles the capture events.
struct Capture {
    /// The video encoder used to encode the frames.
    encoder: Option<VideoEncoder>,
    /// The timestamp of when the capture started, used to calculate the recording duration.
    start: Instant,
    /// The number of frames captured since the last FPS calculation.
    frame_count_since_reset: u64,
    /// The timestamp of the last FPS calculation, used to measure the interval.
    last_reset: Instant,
    /// The settings for the current capture session.
    settings: CaptureSettings,
}

impl GraphicsCaptureApiHandler for Capture {
    /// The type of flags used to pass settings to the `new` function.
    type Flags = CaptureSettings;

    /// The error type that can be returned from the capture handlers.
    type Error = Box<dyn std::error::Error + Send + Sync>;

    /// Called by the library to create a new instance of the handler.
    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        println!("Capture started. Press Ctrl+C to stop.");

        // Configure video settings based on the provided flags.
        let video_settings = VideoSettingsBuilder::new(ctx.flags.width, ctx.flags.height)
            .bitrate(ctx.flags.bitrate)
            .frame_rate(ctx.flags.frame_rate);

        // Create a new video encoder.
        let encoder = VideoEncoder::new(
            video_settings,
            // Disable audio for this example.
            AudioSettingsBuilder::default().disabled(true),
            ContainerSettingsBuilder::default(),
            &ctx.flags.path,
        )?;

        Ok(Self {
            encoder: Some(encoder),
            start: Instant::now(),
            frame_count_since_reset: 0,
            last_reset: Instant::now(),
            settings: ctx.flags,
        })
    }

    /// Called for each new frame that is captured.
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        self.frame_count_since_reset += 1;

        // Calculate the time elapsed since the last FPS reset.
        let elapsed_since_reset = self.last_reset.elapsed();
        // Calculate and display the current FPS.
        let fps = self.frame_count_since_reset as f64 / elapsed_since_reset.as_secs_f64();

        // Print the recording duration and current FPS.
        print!("\rRecording for: {:.2}s | FPS: {:.2}", self.start.elapsed().as_secs_f64(), fps);
        io::stdout().flush()?;

        // Send the frame to the video encoder.
        self.encoder.as_mut().unwrap().send_frame(frame)?;

        // Check if the stop flag has been set (e.g., by Ctrl+C).
        if self.settings.stop_flag.load(Ordering::SeqCst) {
            println!("\nStopping capture...");

            // Finalize the encoding and save the video file.
            self.encoder.take().unwrap().finish()?;

            // Signal the capture loop to stop.
            capture_control.stop();

            println!("\nRecording stopped.");
        }

        // Reset the FPS counter every second.
        if elapsed_since_reset >= Duration::from_secs(1) {
            self.frame_count_since_reset = 0;
            self.last_reset = Instant::now();
        }

        Ok(())
    }

    /// Optional handler for when the capture item (e.g., a window) is closed.
    fn on_closed(&mut self) -> Result<(), Self::Error> {
        println!("Capture item closed, stopping capture.");

        // Stop the capture gracefully.
        self.settings.stop_flag.store(true, Ordering::SeqCst);

        Ok(())
    }
}

/// A command-line interface for screen capturing.
#[derive(Parser)]
#[command(name = "Screen Capture CLI")]
#[command(version = "1.0")]
#[command(author = "Your Name")]
#[command(about = "A simple command-line tool to capture a monitor or a window.")]
struct Cli {
    /// The name of the window to capture.
    #[arg(long, conflicts_with = "monitor_index")]
    window_name: Option<String>,

    /// The index of the monitor to capture (e.g., 1, 2, ...).
    #[arg(long, conflicts_with = "window_name")]
    monitor_index: Option<u32>,

    /// Specifies whether to capture the cursor. Options: [always, never, default]
    #[arg(long, default_value = "default")]
    cursor_capture: String,

    /// Specifies whether to draw a border around the captured item. Options: [always, never,
    /// default]
    #[arg(long, default_value = "default")]
    draw_border: String,

    /// Specifies whether to include secondary windows. Options: [include, exclude, default]
    #[arg(long, default_value = "default")]
    secondary_window: String,

    /// Requests a minimum interval between eligible updates, in milliseconds. This limits the
    /// update rate but does not guarantee a constant frame rate.
    #[arg(long)]
    minimum_update_interval: Option<u64>,

    /// Specifies how to handle dirty regions. Options: [default, report_only, report_and_render]
    #[arg(long, default_value = "default")]
    dirty_region: String,

    /// The path to the output video file.
    #[arg(long, default_value = "video.mp4")]
    path: String,

    /// The bitrate of the video, in bits per second.
    #[arg(long, default_value_t = 15_000_000)]
    bitrate: u32,

    /// The frame rate of the video, in frames per second.
    #[arg(long, default_value_t = 60)]
    frame_rate: u32,
}

/// Parses the string argument for cursor capture settings.
fn parse_cursor_capture(s: &str) -> CursorCaptureSettings {
    match s.to_lowercase().as_str() {
        "always" => CursorCaptureSettings::WithCursor,
        "never" => CursorCaptureSettings::WithoutCursor,
        "default" => CursorCaptureSettings::Default,
        _ => {
            eprintln!("Invalid cursor_capture value: '{}'. Use 'always', 'never', or 'default'.", s);
            std::process::exit(1);
        }
    }
}

/// Parses the string argument for draw border settings.
fn parse_draw_border(s: &str) -> DrawBorderSettings {
    match s.to_lowercase().as_str() {
        "always" => DrawBorderSettings::WithBorder,
        "never" => DrawBorderSettings::WithoutBorder,
        "default" => DrawBorderSettings::Default,
        _ => {
            eprintln!("Invalid draw_border value: '{}'. Use 'always', 'never', or 'default'.", s);
            std::process::exit(1);
        }
    }
}

/// Parses the string argument for secondary window settings.
fn parse_secondary_window(s: &str) -> SecondaryWindowSettings {
    match s.to_lowercase().as_str() {
        "include" => SecondaryWindowSettings::Include,
        "exclude" => SecondaryWindowSettings::Exclude,
        "default" => SecondaryWindowSettings::Default,
        _ => {
            eprintln!("Invalid secondary_window value: '{}'. Use 'include', 'exclude', or 'default'.", s);
            std::process::exit(1);
        }
    }
}

/// Parses the string argument for minimum update interval settings.
fn parse_minimum_update_interval(m: &Option<u64>) -> MinimumUpdateIntervalSettings {
    match m {
        Some(value) if *value > 0 => MinimumUpdateIntervalSettings::Custom(Duration::from_millis(*value)),
        None | Some(0) => MinimumUpdateIntervalSettings::Default,
        _ => {
            eprintln!(
                "Invalid minimum_update_interval value: '{}'. Use a positive integer or leave empty for default.",
                m.unwrap_or(0)
            );
            std::process::exit(1);
        }
    }
}

/// Parses the string argument for dirty region settings.
fn parse_dirty_region(s: &str) -> DirtyRegionSettings {
    match s.to_lowercase().as_str() {
        "default" => DirtyRegionSettings::Default,
        "report_only" => DirtyRegionSettings::ReportOnly,
        "report_and_render" => DirtyRegionSettings::ReportAndRender,
        _ => {
            eprintln!("Invalid dirty_region value: '{}'. Use 'default', 'report_only', or 'report_and_render'.", s);
            std::process::exit(1);
        }
    }
}

/// Starts the capture process with the specified settings.
fn start_capture<T: TryInto<GraphicsCaptureItemType>>(
    capture_item: T,
    cursor_capture_settings: CursorCaptureSettings,
    draw_border_settings: DrawBorderSettings,
    secondary_window_settings: SecondaryWindowSettings,
    minimum_update_interval_settings: MinimumUpdateIntervalSettings,
    dirty_region_settings: DirtyRegionSettings,
    settings: CaptureSettings,
) {
    // Create the settings struct for the capture session.
    let capture_settings = Settings::new(
        capture_item,
        cursor_capture_settings,
        draw_border_settings,
        secondary_window_settings,
        minimum_update_interval_settings,
        dirty_region_settings,
        // BGRA8 is the default and most common format.
        ColorFormat::Bgra8,
        settings,
    );

    // Start the capture and take control of the current thread.
    // Any errors from the capture handler will be propagated here.
    Capture::start(capture_settings).expect("Screen capture failed");
}

fn main() {
    // Parse command-line arguments.
    let cli = Cli::parse();

    // Parse the string arguments into their corresponding enum types.
    let cursor_capture = parse_cursor_capture(&cli.cursor_capture);
    let draw_border = parse_draw_border(&cli.draw_border);
    let secondary_window = parse_secondary_window(&cli.secondary_window);
    let minimum_update_interval = parse_minimum_update_interval(&cli.minimum_update_interval);
    let dirty_region_settings = parse_dirty_region(&cli.dirty_region);

    // Create an atomic boolean flag to signal the capture to stop.
    let stop_flag = Arc::new(AtomicBool::new(false));

    // Set up a Ctrl+C handler to gracefully stop the capture.
    {
        let stop_flag = stop_flag.clone();
        ctrlc::set_handler(move || {
            stop_flag.store(true, Ordering::SeqCst);
        })
        .expect("Failed to set Ctrl+C handler");
    }

    // Determine the capture target (window or monitor) and start the capture.
    if let Some(window_name) = cli.window_name {
        // Find the window by a substring of its title.
        let capture_item = Window::from_contains_name(&window_name)
            .unwrap_or_else(|_| panic!("Window with name containing '{}' not found!", window_name));

        // Automatically determine the window's width and height.
        let rect = capture_item.rect().expect("Failed to get window rect");
        let width = (rect.right - rect.left) as u32;
        let height = (rect.bottom - rect.top) as u32;

        let capture_settings = CaptureSettings {
            stop_flag: stop_flag.clone(),
            width,
            height,
            path: cli.path.clone(),
            bitrate: cli.bitrate,
            frame_rate: cli.frame_rate,
        };

        println!("Capturing window: \"{}\"", capture_item.title().expect("Failed to get window title"));
        println!("Window dimensions: {}x{}", width, height);

        start_capture(
            capture_item,
            cursor_capture,
            draw_border,
            secondary_window,
            minimum_update_interval,
            dirty_region_settings,
            capture_settings,
        );
    } else if let Some(index) = cli.monitor_index {
        // Find the monitor by its index.
        let capture_item = Monitor::from_index(usize::try_from(index).unwrap())
            .unwrap_or_else(|_| panic!("Monitor with index {index} not found!"));

        // Automatically determine the monitor's width and height.
        let width = capture_item.width().expect("Failed to get monitor width");
        let height = capture_item.height().expect("Failed to get monitor height");

        let capture_settings = CaptureSettings {
            stop_flag: stop_flag.clone(),
            width,
            height,
            path: cli.path.clone(),
            bitrate: cli.bitrate,
            frame_rate: cli.frame_rate,
        };

        println!("Capturing monitor {}", index);
        println!("Monitor dimensions: {}x{}", width, height);

        start_capture(
            capture_item,
            cursor_capture,
            draw_border,
            secondary_window,
            minimum_update_interval,
            dirty_region_settings,
            capture_settings,
        );
    } else {
        // If neither a window nor a monitor is specified, print an error and exit.
        eprintln!(
            "Error: You must specify either a window to capture with --window-name or a monitor with --monitor-index."
        );
        std::process::exit(1);
    }
}
