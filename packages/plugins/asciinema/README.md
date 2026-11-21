# Asciinema viewer for Happier

Development source for an opt-in first-party plugin. This package is not bundled
with Happier and has not been published to npm.

Install and enable through Happier's Plugins settings, open a `.cast` workspace
file, and choose **Asciinema** in the viewer chooser. The built-in text viewer
remains available.

The hosted-web player uses the packaged `asciinema-player` dependency and its
stylesheet, with no CDN. Recordings stay data: the plugin never runs recorded
commands. It supports asciicast v2 and v3 and reads one revision-bound snapshot
through the public host API, up to the host's 10,000,000-byte ceiling.
Malformed or oversized files show an explanation; Reload retries an unavailable
or changed file. Playback requires the host's DOM-capable hosted-web renderer.
If that renderer is unavailable, use the built-in text viewer.

Player controls, terminal rendering and responsive sizing come from upstream.
See the [upstream player API](https://docs.asciinema.org/manual/player/api/).

Prepare with `happier plugins dev .`, `happier plugins dev typecheck .`, and
`happier plugins dev build .`. Publication is a separate reviewed operation
through Happier's plugin publisher. The SDK version must resolve to the compatible
published toolchain before an npm release.
