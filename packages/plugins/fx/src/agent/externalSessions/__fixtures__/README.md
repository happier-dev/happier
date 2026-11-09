# FX conversation fixture provenance

Sanitized source-derived v0.0.14 fixture, not an installed-CLI capture. Exact
vendor tag commit: `vercel-labs/fx@1a070af32cdfaf8cd0da6de3dc7f053302828b17`.

- `src/core/session/session_codec.zig:301–360`: schema-4 `session.json` metadata.
- `src/core/session/session_event.zig:24–193,440–500`: conversation frame
  versions 1–3, JSON union encoding, native `seq` and timestamps.
- `src/core/session/session_log.zig:2040–2110,2380–2620`: completed-turn replay,
  steering, interrupted turns and checkpoints. An unfinished tail is not a
  committed turn. Steering retains its assistant prefix.
- `src/acp/sessions.zig:1713–1805,1880–2035`: ACP discovery emits the same native
  session id; history replay visits complete archived turns. Context checkpoints
  change model context but do not erase archived user-visible history; their
  summaries are not emitted as user/assistant messages.
- `src/core/session/result_store.zig:640–660,698–750` and
  `session_child_store.zig:350–362`: result handles name files in `tool-results`.
- Image fixtures characterized 2026-10-27 from the same pinned commit:
  `session_event.zig:47–68` and `shared/types.zig:1393–1405` define user snapshots;
  `session_codec.zig:2663–2682` writes the nonempty image-pack fixture
  `fx-v0.0.14-tool-images.json`, and `result_store.zig:257–288` authenticates
  its raw JSON bytes by the content-digest suffix in the image handle. The tiny
  PNG is the vendor's `images/image_data.zig:559–564` validation vector.
  `source_ref` and the original attachment `path` are opaque context, never
  authority to read another path. The fixture pack's trailing newline is removed
  by the test to match the vendor writer's exact array serialization.

Only prose, identifiers, timestamps and paths were replaced. No vendor writer,
migration, export, server, or Agent turn was run. The opt-in sessions-v2 backend
(`session_adapter.zig:1–27,76–84`) is a distinct dialect and needs explicit
unsupported coverage until separately characterized; it must not become an
empty successful search. Likewise schema-3 metadata/event-log storage is not
schema-4 conversation-frame storage.
