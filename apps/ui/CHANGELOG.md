# Changelog

## Version 0.1.2 - 2026-03-02

This release is a major upgrade to self-hosting and cross-device workflows (plaintext mode, keyless auth, mTLS, "Add Phone" pairing, and safer canonical URLs), plus a big step forward in in-app development features (panes, files/source control, diffs, replay/forking, and OpenCode deeper integration). It also improves reliability across web/desktop/mobile with better crash recovery, diagnostics, notifications controls, and more resilient daemon connectivity.

- Refactored the Files and Source Control UI to support richer session file workflows (changed-files review, repository tree, commit controls, files editing, and safer SCM operations like discard/stage).
- Added directory filtering and viewability tuning helpers for SCM review surfaces.
- Improved SCM reliability with adaptive polling, mutation invalidation, and better fallbacks when session/workspace paths are missing or a session is inactive.
- Improved diff caching and prefetch behavior so loaded diffs are retained more reliably while scrolling and expanding rows.

- Added a new pane-based UI architecture (details/right panes) with lazy loading, prefetching, and route integration for smoother navigation.
- Added multi-pane appearance preferences and improved details tab open/pin behavior.
- Added a resizable permanent sidebar drawer with persisted width preferences.
- Improved connection status UI to show the active server label more clearly.

- Refactored the code diff/rendering stack (Pierre web diff viewer, worker runtime/warmup, virtualization controls, unified folding, and improved syntax/language handling).
- Improved markdown rendering for developer workflows with diff-aware code fences and better table scrolling.
- Fixed a Markdown table rendering issue on Android that could clip content after large tables.
- Fixed a security issue by preventing Mermaid WebView HTML injection.

- Improved transcript UX with tool-call grouping controls and timeline improvements.
- Added compact/collapsible tool card behaviors and richer tool header/status handling (including clearer permission states).
- Added support for freeform “Ask a question” prompts in tool renderers.
- Improved list performance and stability by expanding FlashList usage, with a web fallback to FlatList on known FlashList layout crash signatures.

- Added session fork actions in the UI (from header/info/actions).
- Added “fork from message” semantics so forks happen at the expected point in the conversation.
- Added Happier Replay forking support across providers, including replay-seed propagation for continue/fork workflows.
- Added replay seed sizing limits to prevent oversized prompts and improve reliability.
- Improved replay synopsis retrieval with synopsis pointers and bounded fallback scanning for faster recovery.
- Added replay summary runner configuration support (backend/model), and ensured fork/continue flows forward summary runner settings when needed.

- Implemented major OpenCode runtime/server integration (managed server orchestration, session control, question/prompt handling, and forking support).
- Improved OpenCode runtime stability with readiness/health polling, safer shutdown cleanup, and better fallbacks when idle streaming is missing.

- Added support for session pinning
- Added support for session tags

- Improved permissions display UI
- Improved permissions notifications & user actions notifications

- Added plaintext storage mode support for self-hosted servers (so sessions can be stored plaintext-at-rest when configured).
- Added keyless external authentication support for self-hosted and enterprise auth providers.
- Added mTLS login support for environments that require certificate-based authentication.
- Added an “Add your phone” pairing flow, including QR-based pairing from web/desktop and in-app pairing helpers.
- Added QR restore flows so reconnecting a device is smoother when migrating or recovering access.
- Added in-app QR scanner routes (with better mobile-web gating) for pairing/connect flows.

- Improved QR codes and share links so they never embed `localhost` / loopback server URLs (so scanning on mobile won’t switch you to an unreachable server).
- Improved server override safety so loopback-only links won’t override an already-working non-loopback server selection.
- Added clearer in-app guidance when a QR/link cannot include a shareable server URL.

- Added canonical server URL support for self-hosted servers, with safer adoption rules (including insecure URL guards).
- Added canonical URL inference from Tailscale Serve status and improved flows to prefer the server-defined canonical URL where possible.
- Improved welcome/auth flows to be more resilient when server feature snapshots are unavailable or server switching aborts mid-flow.

- Added a web startup safety gate that fails closed when required WebCrypto primitives are unavailable (instead of partially breaking later).
- Added OIDC callback `iss` passthrough handling for RFC 9207 compatibility with more identity providers.

- Connected Services: added/expanded Codex cloud auth (PKCE + device auth) and improved connect guidance.
- Connected Services: added Claude subscription OAuth cloud-connect flow (and improved token exchange/materialization).
- Connected Services: unified OAuth routing across embedded/device/paste flows and improved error handling, labeling consistency, and quotas behavior.

- Added an “Installables” catalog surface in machine details so you can see detected/available tools more clearly.
- Added a System Status screen (app/server/machine health, grouped machine status, and system actions).
- Added a Diagnosis screen that runs probes and produces a structured diagnosis report with findings.

- Added `happier doctor --json` snapshot output for easier debugging and support workflows.
- Improved bug reports to ingest doctor snapshots (daemon + pasted CLI), enrich diagnostics context, and handle missing server diagnostics gracefully.
- Added crash recovery UI that shows a safe fallback screen with restart + copy-details actions when the app hits a render-time crash.
- Added “restart-intent” bug report flows so a queued report can reopen automatically after relaunch, preserving pre-restart diagnostics.
- Improved crash reporting by attaching Sentry event artifacts on submit (when available) and adding crash-report gating helpers.

- Added interactive push notification actions.
- Added an “In-app notifications” setting (Full / Silent / Off) and suppressed notifications for the session you’re actively viewing (so you don’t get spammed while reading).

- Improved daemon startup/readiness to reduce early RPC races (fewer “method not available” failures during startup).
- Improved daemon/service PATH handling and service reliability on Linux/macOS (systemd/launchd), including better credential repair and safer service behaviors.
- Improved Windows command/shim execution and spawn reliability for provider CLIs and subprocesses.

- Added a safer clipboard write helper so copy actions fail gracefully instead of erroring.
- Improved text selectability across transcript/tool/review/command surfaces for easier copy/paste and review.

- Added reduced-motion accessibility support.
- Expanded localization across tools, runs, files, settings, voice, automations, navigation, and modals.

## Version 0.1.0 - 2026-02-15

Welcome to Happier - your secure, encrypted mobile companion for Claude Code. This inaugural release establishes the foundation for private, powerful AI interactions on the go.

- Implemented end-to-end encrypted session management ensuring complete privacy
- Integrated intelligent voice assistant with natural conversation capabilities
- Added experimental file manager with syntax highlighting and tree navigation
- Built seamless real-time synchronization across all your devices
- Established native support for iOS, Android, and responsive web interfaces
