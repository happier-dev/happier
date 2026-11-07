# Upstash Box Machines

Development-only thin REST v2 leaf for `machineProvisioners`. The existing Account
Connected Account owner stores and materializes a selected Box API key as
`X-Box-Api-Key`; provider credentials never enter launch/resource records or guest
files. The same roles run on Account and daemon hosts through the public SDK.

The shared managed enrollment recipe consumes native exec/file operations and
installs the ordinary binary Happier daemon. The leaf preserves binary files,
stdin, stdout, stderr and exit status through the native text exec envelope.
Startup uses the host-built daemon argv and Box's native init-command endpoint.
No vendor SDK, system Node bootstrap, Home proxy or separate lifecycle owner is used.

Boxes use the Debian Node runtime and small/medium/large native sizes. Inspection
does not wake a paused box. Explicit start/resume uses the retained box id; stop
pauses and preserves files. Upstash auto-pauses idle boxes according to its plan
(current docs: one hour free, six hours paid). That native behavior is not a
Happier inactivity policy. Paused boxes stop active CPU billing but retain billed
storage. No undocumented deletion deadline is invented. Delete is retained as an
accepted operation until a demanded read proves deleted/404; snapshots, if any,
remain vendor-owned and are not deleted by this leaf.

An interrupted create recovers by its captured name and verifies its managed
label, without a replacement purchase. Cancelling fetch does not prove that a
submitted vendor command or create stopped; inspect/retry the retained resource.
Browser reachability is false because the complete authenticated CORS path has
not been qualified. Native app/desktop and daemon hosts use the same HTTP client.

Contract basis: official Upstash Box docs (Box Basics, Filesystem, Shell, Keep
Alive) and official `@upstash/box` 0.7.10 source commit
`170dd8b988211deaf788b64c855f3765f2c20ef9`, checked 2026-11-01. No upstream code is
copied or SDK dependency added. The file docs state 100 MB per uploaded file and
about 1 GB per upload request; those are vendor upload limits, not new Happier
cutoffs. HTTP refusals stay visible and no leaf retry or custom timer is added.

Release check: with explicit tenant/spend authorization, run create → shared
enrollment → ordinary Session → binary exec/file → pause/resume → destroy,
including native init startup, plan auto-pause and token export. This lane makes
no real vendor lifecycle calls.

- https://upstash.com/docs/box/overall/how-it-works
- https://upstash.com/docs/box/overall/files
- https://upstash.com/docs/box/overall/shell
- https://upstash.com/docs/box/overall/keep-alive
- https://github.com/upstash/box/tree/170dd8b988211deaf788b64c855f3765f2c20ef9/packages/sdk/src
