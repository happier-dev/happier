//! # Windows Capture Rust Library
//!
//! **Windows Capture** is a highly efficient Rust and Python library that
//! enables you to effortlessly capture the screen using the Graphics Capture
//! API. This library allows you to easily capture the screen of your
//! Windows-based computer and use it for various purposes, such as creating
//! instructional videos, taking screenshots, or recording your gameplay. With
//! its intuitive interface and robust functionality, Windows Capture is an
//! excellent choice for anyone looking for a reliable and easy-to-use screen
//! capturing solution.
//!
//! ## Features
//!
//! - Updates frames only when required
//! - High performance
//! - Easy to use
//! - Uses the latest Windows Graphics Capture API
//! - Supports the DXGI Desktop Duplication API
//! - Enhanced, hardware-accelerated video encoder with stable audio timing
//!
//! ## Installation
//!
//! Add this library to your `Cargo.toml`:
//!
//! ```toml
//! [dependencies]
//! windows-capture = "2.0.0"
//! ```
//! Or run this command:
//!
//! ```text
//! cargo add windows-capture
//! ```
//!
//! ## Usage
//!
//! ```no_run
//! use std::io::{self, Write};
//! use std::time::Instant;
//!
//! use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
//! use windows_capture::encoder::{
//!     AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
//! };
//! use windows_capture::frame::Frame;
//! use windows_capture::graphics_capture_api::InternalCaptureControl;
//! use windows_capture::graphics_capture_picker::GraphicsCapturePicker;
//! use windows_capture::settings::{
//!     ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
//!     MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
//! };
//!
//! // Handles capture events.
//! struct Capture {
//!     // The video encoder that will be used to encode the frames.
//!     encoder: Option<VideoEncoder>,
//!     // To measure the time the capture has been running
//!     start: Instant,
//! }
//!
//! impl GraphicsCaptureApiHandler for Capture {
//!     // The type of flags used to get the values from the settings, here they are the width and height.
//!     type Flags = (i32, i32);
//!
//!     // The type of error that can be returned from `CaptureControl` and `start`
//!     // functions.
//!     type Error = Box<dyn std::error::Error + Send + Sync>;
//!
//!     // Function that will be called to create a new instance. The flags can be
//!     // passed from settings.
//!     fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
//!         // If we didn't want to get the size from the settings, we could use frame.width() and frame.height()
//!         // in the on_frame_arrived function, but we would need to create the encoder there.
//!         let encoder = VideoEncoder::new(
//!             VideoSettingsBuilder::new(ctx.flags.0 as u32, ctx.flags.1 as u32),
//!             AudioSettingsBuilder::default().disabled(true),
//!             ContainerSettingsBuilder::default(),
//!             "video.mp4",
//!         )?;
//!
//!         Ok(Self { encoder: Some(encoder), start: Instant::now() })
//!     }
//!
//!     // Called every time a new frame is available.
//!     fn on_frame_arrived(
//!         &mut self,
//!         frame: &mut Frame,
//!         capture_control: InternalCaptureControl,
//!     ) -> Result<(), Self::Error> {
//!         print!("\rRecording for: {} seconds", self.start.elapsed().as_secs());
//!         io::stdout().flush()?;
//!
//!         // Send the frame to the video encoder
//!         self.encoder.as_mut().unwrap().send_frame(frame)?;
//!
//!         // The frame has other uses too, for example, you can save a single frame
//!         // to a file, like this: frame.save_as_image("frame.png", ImageFormat::Png)?;
//!         // Or get the raw data like this so you have full control: let data = frame.buffer()?;
//!
//!         // Stop the capture after 6 seconds
//!         if self.start.elapsed().as_secs() >= 6 {
//!             // Finish the encoder and save the video.
//!             self.encoder.take().unwrap().finish()?;
//!
//!             capture_control.stop();
//!
//!             // Because the previous prints did not include a newline.
//!             println!();
//!         }
//!
//!         Ok(())
//!     }
//!
//!     // Optional handler called when the capture item (usually a window) is closed.
//!     fn on_closed(&mut self) -> Result<(), Self::Error> {
//!         println!("Capture session ended");
//!
//!         Ok(())
//!     }
//! }
//!
//! // Opens a dialog to pick a window or screen to capture; refer to the docs for other capture items.
//! let item = GraphicsCapturePicker::pick_item().expect("Failed to pick item");
//!
//! // If the user canceled the selection, exit.
//! let Some(item) = item else {
//!     println!("No item selected");
//!     return;
//! };
//!
//! // Get the size of the item to pass to the settings.
//! let size = item.size().expect("Failed to get item size");
//!
//! let settings = Settings::new(
//!     // Item to capture
//!     item,
//!     // Capture cursor settings
//!     CursorCaptureSettings::Default,
//!     // Draw border settings
//!     DrawBorderSettings::Default,
//!     // Secondary window settings, if you want to include secondary windows in the capture
//!     SecondaryWindowSettings::Default,
//!     // Minimum interval between eligible updates. This limits the update rate but does not
//!     // guarantee a constant frame rate. Default leaves the Windows setting unchanged.
//!     MinimumUpdateIntervalSettings::Default,
//!     // Dirty region settings
//!     DirtyRegionSettings::Default,
//!     // The desired color format for the captured frame.
//!     ColorFormat::Rgba8,
//!     // Additional flags for the capture settings that will be passed to the user-defined `new` function.
//!     size,
//! );
//!
//! // Starts the capture and takes control of the current thread.
//! // The errors from the handler trait will end up here.
//! Capture::start(settings).expect("Screen capture failed");
//! ```
#![warn(clippy::nursery)]
#![warn(clippy::cargo)]
#![warn(clippy::multiple_crate_versions)]
#![warn(missing_docs)]

/// Exported for the trait bounds
pub use windows::Graphics::Capture::GraphicsCaptureItem;

/// Contains safe wrapper for WinRT initialization.
pub(crate) mod winrt;

/// Contains the main capture functionality, including the
/// [`crate::capture::GraphicsCaptureApiHandler`] trait and related types.
pub mod capture;
/// Internal module for Direct3D 11 related functionality.
pub mod d3d11;
/// Contains types and functions related to the DXGI Desktop Duplication API.
pub mod dxgi_duplication_api;
/// Contains the encoder functionality for encoding captured frames, including
/// [`crate::encoder::VideoEncoder`].
pub mod encoder;
/// Contains the [`crate::frame::Frame`] struct and related types for representing captured frames.
pub mod frame;
/// Contains the types and functions related to the Graphics Capture API.
pub mod graphics_capture_api;
/// Contains the functionality for displaying a picker to select a window or screen to capture:
/// [`crate::graphics_capture_picker::GraphicsCapturePicker`].
pub mod graphics_capture_picker;
/// Contains functionality for working with monitors and screen information:
/// [`crate::monitor::Monitor`].
pub mod monitor;
/// Contains the [`crate::settings::Settings`] struct and related types for configuring capture
/// settings.
pub mod settings;
/// Contains functionality for working with windows and capturing specific windows:
/// [`crate::window::Window`].
pub mod window;
