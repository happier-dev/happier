# Remote access (Tailscale + phone)

Happier relies on “secure context” browser features (WebCrypto). Browsers treat `http://localhost` as a secure context, but **not** `http://<lan-ip>:<port>` or `http://<tailscale-ip>:<port>`.

For remote access (phone, another laptop, etc) you should use **HTTPS**.

The recommended approach is **Tailscale Serve**, which gives you an `https://*.ts.net` URL for your machine that is only accessible inside your tailnet.

## Quickstart

1) Install Tailscale and sign in on your computer.

2) Enable Serve:

```bash
hstack tailscale enable
hstack tailscale url
```

3) Open the URL from `hstack tailscale url` on another device (also signed into Tailscale).

Tip: on iOS, you can “Add to Home Screen” from Safari to use it like an app.

## Automation

If Serve is already configured, `hstack start` will automatically prefer the `https://*.ts.net` URL for canonical/share links unless you explicitly set `HAPPIER_STACK_SERVER_URL`.

Tip: for self-hosted servers, also set `HAPPIER_PUBLIC_SERVER_URL` (usually to the same `https://*.ts.net` URL). That value is advertised by the server via `GET /v1/features` and is what clients embed in QR/deep links.

You can also ask hstack to enable Serve automatically at boot:

```bash
HAPPIER_STACK_TAILSCALE_SERVE=1 hstack start
```

Useful knobs:
- `HAPPIER_STACK_TAILSCALE_WAIT_MS`
- `HAPPIER_TAILSCALE_BIN` (preferred unified override)
- `HAPPIER_STACK_TAILSCALE_BIN` (legacy stack-specific alias)

In current 0.3 development source, `hstack tailscale disable` and its `reset`
alias remove only the current stack's matching HTTPS route. Other paths and
listeners, including database routes, remain configured. Setting
`HAPPIER_STACK_TAILSCALE_RESET_ON_EXIT=1` uses the same scoped cleanup.
Enabling Serve refuses to replace an unrelated root mapping on that listener.

### Mac execution hosts

In unreleased 0.3 development source, an execution host's `hstack start` or
`hstack dev` reconciles its declared workspace service tunnels. The server
tunnel targets the controller's stable server port, so server backend reloads
keep the same public route. Host-local service placement retains its own local
endpoint.

If Serve returns 502 while the controller's `/health` works, inspect the tunnel
on the Mac with `hstack dev-vm forward status --workspace-id=0.3 --json` and repair
it with `hstack dev-vm forward reconcile --workspace-id=0.3 --json`, using the
workspace id from that host's execution-host profile. This reconciles the
existing tunnel without restarting the stack or changing other Serve routes.

### Serve change refused

If a Serve change fails with `401 … must be root, or be an operator`, check
the host account's authorization. On Linux with Tailscale 1.104.2, an empty
account display name (GECOS) can also cause this refusal for a configured
operator: [upstream issue #21204](https://github.com/tailscale/tailscale/issues/21204).
The bug uses the display name instead of the login name when checking a
configuration containing file-path or Unix-socket handlers; an existing handler
can therefore make a proxy-only change fail. [Fix PR #21257](https://github.com/tailscale/tailscale/pull/21257)
remains open as of 29 October 2026.

On an affected Linux host, set the display name to the account's login name
with `sudo usermod --comment <login-name> <login-name>`, then retry. Alternatively,
run the exact refused `tailscale` command with `sudo`. If the account is not an
operator, the host owner can run `tailscale set --operator=<login-name>` (with
`sudo` when required); see [Tailscale's operator permissions guide](https://tailscale.com/docs/reference/troubleshooting/linux/linux-operator-permission).

## Development Iroh relay

In current unreleased **0.3 development source**, a fresh `hstack start` or
`hstack dev` ensures one persistent native Iroh relay on the stack's **server host**,
shared by its stacks. Placed stacks prepare it through the existing server target
command path and advertise that host's tailnet HTTPS name; local stacks prepare
it locally. This is a development/QA transport relay, not a production relay
deployment. Existing running stacks pick up the change at their owner's next start.

The host must be signed into Tailscale with HTTPS certificates enabled and
permission to configure Serve and obtain a certificate. Forwarding uses
`https://<machine>.<tailnet>.ts.net:<relay-port>`; QAD listens on the host's tailnet
address at **UDP 7842**, which the host firewall and tailnet policy must permit.
[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
handles HTTPS/TCP forwarding, not UDP. The existing Home/UI HTTPS 443 route and
database mappings remain configured.

At ensure, the relay reads `tailscale serve status --json` and keeps its existing
owned listener or retained free port. Otherwise it allocates from 8443, skipping
occupied Serve listeners and TCP ports. The existing host runtime state retains
the selection across relay stops and restarts; all stacks on that host advertise
the chosen port in their relay URL. Foreign routes are never replaced. An unreadable
inventory or unavailable port yields a typed degraded reason and remediation;
resolve that condition on the server host, then retry the owner's stack start.

The stack reuses the pinned `deploy/iroh-relay` profile: stock `iroh-relay`
1.1.0 with forwarding and QUIC address discovery (QAD). The native process runs
with `--dev`, forwarding over loopback HTTP behind Serve's HTTPS listener while
using a real certificate for QAD. It selects an exact-version binary from
`HAPPIER_STACK_IROH_RELAY_BIN`, the host tools cache, or PATH; otherwise Cargo
installs the locked crate with the `server` feature into the host tools cache.
Cargo discovery includes `CARGO_HOME` and the operating user's rustup installation,
even when a non-login worker's PATH omits it. Placed startup performs acquisition
on the server target using that target's Stack home.
No repository dependency install is needed. You can prepare or inspect it with:

```bash
hstack tools iroh-relay install
hstack tools iroh-relay status
```

Only a verified ready HTTPS URL is passed to stack-managed Home servers,
Machine daemons and UI processes as `HAPPIER_IROH_RELAY_URLS`, with policy
`automatic`, including placed processes and later stack CLI wrappers/service
installation. Explicit external relay settings retain their values. If managed
relay setup is disabled or degraded, hstack clears the relay URL and selects
policy `disabled`; the usual Home HTTPS path remains available. Inspect
`hstack stack info <name> --json` at `runtime.irohRelay` and `hstack doctor --json` at
`irohRelay` for readiness, the typed failure reason and remediation. Run
`hstack tools iroh-relay status --json` on the server host, using the same Stack
home as its placed services, to inspect current host process, health and Serve
readiness. Failed preparation or status recovery also includes `failure.phase`
and `failure.code`: the lifecycle stage and a closed relay/system error code or
JavaScript error class. Unexpected exceptions keep `relay_start_failed` as the
outer reason. Diagnostics omit exception messages, paths and captured tool output.
Tailscale command failures retain `TailscaleCommandError` and its numeric `exitCode`.
If a previously started managed relay has exited unexpectedly, this
command attempts to re-ensure it once through the same locked host lifecycle owner;
it returns the current ready result or a typed degraded reason if recovery fails.
It does not start a relay after explicit stop, when none has started, or while
managed relay use is disabled. There is no background restart timer: recovery runs
on host tools status or the next stack start. Stack info and doctor remain
observations; an absent process reports `relay_process_unavailable` rather than
replaying a historical preparation failure. Its `failure` field includes the last
retained startup diagnostic when present; ready observations omit it. If a failed
ensure cannot save its diagnostic, its output includes `diagnosticRetained: false`.
The stack's `runtime.irohRelay`
retains its last start result. `install --json` emits a typed failure result on
stdout and exits nonzero if acquisition fails.

Certificate failures distinguish `relay_certificate_permission_denied`,
`relay_certificate_https_disabled`, `relay_certificate_files_unavailable` and
other issuance failures (`relay_certificate_unavailable`). A permission failure
asks the host owner to grant the account operating the relay access to Tailscale;
on Unix, the remediation includes `sudo tailscale set --operator=<account>`.
Only the owner runs that command. HTTPS configuration failures require the
tailnet administrator to enable MagicDNS and HTTPS Certificates in the
[Tailscale DNS settings](https://tailscale.com/docs/how-to/set-up-https-certificates).
Resolve the reported problem, then retry the stack start. Certificate failure
never substitutes a self-signed certificate or disables TLS verification.

Stopping a stack leaves the host relay running for other stacks. To stop it
explicitly, run `hstack tools iroh-relay stop` on the server host with the same
Stack home. This stops the shared host relay and removes only its matching HTTPS
route. `HAPPIER_STACK_IROH_RELAY=0` opts only the requesting stack out; it leaves
the host relay and its exposure untouched. A stack restart also preserves them.

[File-based Tailscale certificates](https://tailscale.com/docs/how-to/set-up-https-certificates)
expire after 90 days and require owner renewal. There is no custom renewal
timer: arrange an explicit relay stop and the owner's next stack start to obtain
and load renewed certificate files.

For temporary Lume/cloud enrollment replays in unreleased 0.3 development source,
set `HAPPIER_STACK_IROH_RELAY_FUNNEL=1` on the requesting stack before its next
ensure. The managed host relay then uses [Tailscale Funnel](https://tailscale.com/docs/reference/tailscale-cli/funnel)
to expose only its HTTP endpoints and forwarding service to the public internet.
Its HTTPS URL remains reachable from the tailnet and replaces the advertised
`HAPPIER_IROH_RELAY_URLS` through the usual projection. Funnel does not carry UDP
QAD or expose the existing Home/UI routes.

The relay selects from the node's `funnel-ports` capability, falling back to
Tailscale's documented ports 443/8443/10000 when that capability is absent. It
skips foreign or occupied listeners and never makes a port with other routes
public. If no eligible port is free, preparation degrades without reassigning
those routes. `runtime.irohRelay.exposure` in stack info reports `public` only
when the observed Serve JSON `AllowFunnel` entry is true. A refused or ineffective
enable reports `degraded` with reason `funnel_unavailable`, exposure `tailnet`,
and keeps advertising the working tailnet URL. Resolve the Tailscale refusal and
retry ensure to enable public access.

The host's `iroh-relay/stack.runtime.json` records the explicit request and its
enabling stack in `relayFunnel`. Every stack inherits that decision and the same
HTTPS URL; an ensure without the variable preserves the exposure and port.
Removing the variable does not turn Funnel off, and process recovery retains it.

Turn public access off by setting `HAPPIER_STACK_IROH_RELAY_FUNNEL=0` on the stack
that enabled it and ensuring again. This disables the recorded Funnel mapping
and restores tailnet-only forwarding on the retained port. Another stack's `0`
does not clear the request. To override it explicitly, run
`hstack tools iroh-relay stop` on the server host with the same Stack home. This
removes the owned mapping and clears the request; a later ordinary ensure starts
tailnet-only. A stack that still explicitly supplies `1` can enable it again.
Ordinary stack stop leaves the shared relay running. Funnel's background
configuration persists until disabled, including across Tailscale restarts.
The separate `HAPPIER_STACK_IROH_RELAY=0`, policy `disabled`, and sandbox
opt-outs disable relay use only in that stack. They never stop the shared process,
remove the mapping, or clear the host exposure decision, including for placed servers.
Outside-tailnet reachability must still be checked by the enrollment replay.
See the [Iroh deployment guide](../../../deploy/iroh-relay/README.md) for the
separate operator-managed profile.

## Using the native Happier mobile app (optional)

The native Happier mobile app has an “API Endpoint” setting (developer mode).
Point it at the same HTTPS `*.ts.net` URL to use your local server.

However, the simplest option is usually the **served web UI** (no app updates needed).
