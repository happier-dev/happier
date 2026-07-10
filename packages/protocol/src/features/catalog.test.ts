import { describe, expect, it } from 'vitest';

import { FEATURE_CATALOG, FEATURE_IDS, isFeatureId, type FeatureId } from './catalog.js';
import type { FeatureFailMode } from './catalogTypes.js';

describe('feature catalog', () => {
  it('contains unique feature ids', () => {
    const unique = new Set(FEATURE_IDS);
    expect(unique.size).toBe(FEATURE_IDS.length);
  });

  // X5 (G9-G): every feature entry must declare an explicit fail mode — fail-closed is the catalog
  // default, never an implicit fallback resolved at a consumer. These closure tests fail the build if
  // any entry is missing/invalid, or silently fail-opens without being enumerated as a reviewed
  // exception, so the fail-safe posture cannot drift as the catalog grows.
  it('declares an explicit, valid fail mode on every feature entry (no implicit default)', () => {
    const VALID_FAIL_MODES = new Set<FeatureFailMode>(['fail_closed', 'fail_open']);
    const missing: string[] = [];
    const invalid: string[] = [];
    for (const featureId of FEATURE_IDS) {
      const entry = FEATURE_CATALOG[featureId];
      // Read the OWN property so an absent value surfaces as `undefined` (an implicit default), never
      // a coincidental match.
      const failMode = (entry as { defaultFailMode?: unknown }).defaultFailMode;
      if (failMode === undefined) {
        missing.push(featureId);
        continue;
      }
      if (!VALID_FAIL_MODES.has(failMode as FeatureFailMode)) {
        invalid.push(`${featureId}=${String(failMode)}`);
      }
    }
    expect(missing).toEqual([]);
    expect(invalid).toEqual([]);
  });

  it('defaults every feature entry to fail_closed unless explicitly enumerated as fail_open', () => {
    // Keeping this set empty asserts the whole catalog is fail-closed by default. Adding an id here is
    // an explicit, reviewed decision to fail-open a specific feature — never an implicit fallback.
    const EXPLICIT_FAIL_OPEN_FEATURE_IDS: ReadonlySet<FeatureId> = new Set<FeatureId>();
    const unexpectedFailOpen: string[] = [];
    for (const featureId of FEATURE_IDS) {
      if (
        FEATURE_CATALOG[featureId].defaultFailMode === 'fail_open'
        && !EXPLICIT_FAIL_OPEN_FEATURE_IDS.has(featureId)
      ) {
        unexpectedFailOpen.push(featureId);
      }
    }
    expect(unexpectedFailOpen).toEqual([]);
  });

  it('does not include legacy inbox.friends feature id', () => {
    expect(isFeatureId('inbox.friends')).toBe(false);
  });

  it('includes files feature ids', () => {
    expect(isFeatureId('files.reviewComments')).toBe(true);
    expect(isFeatureId('files.diffSyntaxHighlighting')).toBe(true);
    expect(isFeatureId('files.editor')).toBe(true);
    expect(isFeatureId('files.syntaxHighlighting.advanced')).toBe(true);
    expect(isFeatureId('files.markdownRichEditor')).toBe(true);
  });

  it('includes markdown rich editor as a client feature depending on the embedded editor', () => {
    expect(isFeatureId('files.markdownRichEditor')).toBe(true);
    expect(FEATURE_CATALOG['files.markdownRichEditor']?.representation).toBe('client');
    expect(FEATURE_CATALOG['files.markdownRichEditor']?.dependencies).toEqual(['files.editor']);
    expect(FEATURE_CATALOG['files.markdownRichEditor']?.defaultFailMode).toBe('fail_closed');
  });

  it('includes execution runs feature id', () => {
    expect(isFeatureId('execution.runs')).toBe(true);
  });

  it('includes pets feature ids', () => {
    expect(isFeatureId('pets.companion')).toBe(true);
    expect(isFeatureId('pets.sync')).toBe(true);
    expect(FEATURE_CATALOG['pets.sync']?.representation).toBe('server');
    expect(FEATURE_CATALOG['pets.sync']?.dependencies).toEqual([]);
  });

  it('includes connected services quotas feature id', () => {
    expect(isFeatureId('connectedServices.quotas')).toBe(true);
  });

  it('includes connected-service account group and usage-limit recovery feature ids', () => {
    expect(isFeatureId('sessions.usageLimitRecovery')).toBe(true);
    expect(isFeatureId('connectedServices.accountGroups')).toBe(true);
    expect(isFeatureId('connectedServices.accountFallback')).toBe(true);
    expect(FEATURE_CATALOG['sessions.usageLimitRecovery']?.dependencies).toEqual(['sessions']);
    expect(FEATURE_CATALOG['connectedServices.accountGroups']?.dependencies).toEqual(['connectedServices']);
    expect(FEATURE_CATALOG['connectedServices.accountFallback']?.dependencies).toEqual([
      'connectedServices.accountGroups',
      'sessions.usageLimitRecovery',
    ]);
    expect(FEATURE_CATALOG['sessions.usageLimitRecovery']?.representation).toBe('server');
  });

  it('includes remote hosts feature ids', () => {
    expect(isFeatureId('remoteHosts.management')).toBe(true);
    expect(isFeatureId('remoteHosts.secretMaterial')).toBe(true);
  });

  it('includes channel bridge feature ids', () => {
    expect(isFeatureId('channelBridges')).toBe(true);
    expect(isFeatureId('channelBridges.telegram')).toBe(true);
  });

  it('includes OTA updates feature id', () => {
    expect(isFeatureId('updates.ota')).toBe(true);
  });

  it('includes attachments uploads feature id', () => {
    expect(isFeatureId('attachments.uploads')).toBe(true);
  });

  it('includes activity surfaces feature ids', () => {
    expect(isFeatureId('app.ui.liveActivities')).toBe(true);
    expect(isFeatureId('app.ui.homeScreenWidgets')).toBe(true);
  });

  it('includes direct sessions feature id', () => {
    expect(isFeatureId('sessions.direct')).toBe(true);
  });

  it('represents provider features on the server with exact dependency closure', () => {
    expect(FEATURE_CATALOG.providers).toMatchObject({
      representation: 'server',
      defaultFailMode: 'fail_closed',
      dependencies: [],
    });
    expect(FEATURE_CATALOG['providers.localDiscovery']).toMatchObject({
      representation: 'server',
      defaultFailMode: 'fail_closed',
      dependencies: ['providers', 'localServices.inventory'],
    });
    expect(FEATURE_CATALOG['providers.localModelManagement']).toMatchObject({
      representation: 'server',
      defaultFailMode: 'fail_closed',
      dependencies: ['providers'],
    });
  });

  it('includes terminal byte-stream transport as server-represented embedded PTY dependent feature', () => {
    expect(isFeatureId('terminal.transport.byteStream')).toBe(true);
    expect(FEATURE_CATALOG['terminal.transport.byteStream']?.representation).toBe('server');
    expect(FEATURE_CATALOG['terminal.transport.byteStream']?.dependencies).toEqual(['terminal.embeddedPty']);
    expect(FEATURE_CATALOG['terminal.transport.byteStream']?.defaultFailMode).toBe('fail_closed');
  });

  it('includes Codex app-server feature ids as client-represented runtime capabilities', () => {
    expect(isFeatureId('agents.codex.appServer.goals')).toBe(true);
    expect(isFeatureId('agents.codex.appServer.plugins')).toBe(true);
    expect(isFeatureId('agents.codex.appServer.structuredInput')).toBe(true);
    expect(isFeatureId('agents.codex.appServer.permissionProfiles')).toBe(true);
    expect(FEATURE_CATALOG['agents.codex.appServer.goals']?.representation).toBe('client');
    expect(FEATURE_CATALOG['agents.codex.appServer.goals']?.dependencies).toEqual([]);
    expect(FEATURE_CATALOG['agents.codex.appServer.plugins']?.dependencies).toContain('prompts.skills.registries');
    expect(FEATURE_CATALOG['agents.codex.appServer.structuredInput']?.dependencies).toContain('attachments.uploads');
  });

  it('includes Claude unified terminal as a client-represented runtime capability', () => {
    expect(isFeatureId('agents.claude.unifiedTerminal')).toBe(true);
    expect(FEATURE_CATALOG['agents.claude.unifiedTerminal']?.representation).toBe('client');
    expect(FEATURE_CATALOG['agents.claude.unifiedTerminal']?.dependencies).toEqual(['sessions.direct']);
  });

  it('includes the Claude unified terminal TUI runtime-control gate (fail-closed, unified-dependent)', () => {
    expect(isFeatureId('agents.claude.unifiedTerminal.tuiRuntimeControl')).toBe(true);
    expect(FEATURE_CATALOG['agents.claude.unifiedTerminal.tuiRuntimeControl']?.representation).toBe('client');
    expect(FEATURE_CATALOG['agents.claude.unifiedTerminal.tuiRuntimeControl']?.defaultFailMode).toBe('fail_closed');
    expect(FEATURE_CATALOG['agents.claude.unifiedTerminal.tuiRuntimeControl']?.dependencies).toEqual(['agents.claude.unifiedTerminal']);
  });

  it('includes session handoff feature ids', () => {
    expect(isFeatureId('sessions.handoff')).toBe(true);
    expect(isFeatureId('sessions.handoff.serverRoutedTransfer')).toBe(false);
    expect(isFeatureId('machines.transfer.serverRouted')).toBe(true);
    expect(isFeatureId('machines.transfer.directPeer')).toBe(true);
    expect(isFeatureId('machines.transfer.directPeer.transportRns')).toBe(false);
  });

  it('includes session folders as a server-represented session feature', () => {
    expect(isFeatureId('sessions.folders')).toBe(true);
    expect(FEATURE_CATALOG['sessions.folders']?.representation).toBe('server');
    expect(FEATURE_CATALOG['sessions.folders']?.dependencies).toEqual(['sessions']);
  });

  it('includes peer mediation direct and server-routed feature ids', () => {
    expect(isFeatureId('machines.peerMediation')).toBe(true);
    expect(isFeatureId('machines.peerMediation.observability')).toBe(true);
    expect(isFeatureId('machines.tunnel.directPeer')).toBe(true);
    expect(isFeatureId('machines.tunnel.serverRouted')).toBe(true);
    expect(isFeatureId('machines.liveStream.directPeer')).toBe(true);
    expect(isFeatureId('machines.liveStream.serverRouted')).toBe(true);
    expect(isFeatureId('machines.rpc.directPeer')).toBe(true);
    expect(FEATURE_CATALOG['machines.peerMediation']?.dependencies).toEqual(['machines']);
    expect(FEATURE_CATALOG['machines.peerMediation.observability']?.dependencies).toEqual(['machines.peerMediation']);
    expect(FEATURE_CATALOG['machines.peerMediation.observability']?.representation).toBe('server');
    const forbiddenServerRoutedRpcFeatureId = ['machines.rpc', 'serverRouted'].join('.');
    expect(isFeatureId(forbiddenServerRoutedRpcFeatureId)).toBe(false);
  });

  it('includes local service preview and public exposure feature ids', () => {
    expect(isFeatureId('localServices')).toBe(true);
    expect(isFeatureId('localServices.inventory')).toBe(true);
    expect(isFeatureId('localServices.managed')).toBe(true);
    expect(isFeatureId('localServices.preview')).toBe(true);
    expect(isFeatureId('localServices.publicPreview')).toBe(true);
    expect(isFeatureId('localServices.launcher')).toBe(true);
    expect(isFeatureId('localServices.actions')).toBe(true);
    expect(isFeatureId('localServices.actions.terminate')).toBe(true);
    expect(FEATURE_CATALOG['localServices.inventory']?.dependencies).toEqual(['localServices']);
    expect(FEATURE_CATALOG['localServices.managed']?.dependencies).toEqual(['localServices.inventory']);
    expect(FEATURE_CATALOG['localServices.preview']?.dependencies).toEqual(['localServices.inventory']);
    expect(FEATURE_CATALOG['localServices.publicPreview']?.dependencies).toEqual(['localServices.preview']);
    expect(FEATURE_CATALOG['localServices.actions']?.dependencies).toEqual(['localServices.inventory']);
    expect(FEATURE_CATALOG['localServices.actions.terminate']?.dependencies).toEqual(['localServices.actions']);
    expect(FEATURE_CATALOG['localServices.launcher']?.dependencies).toEqual([
      'localServices.inventory',
      'browser.viewTargets',
    ]);
    expect(FEATURE_CATALOG['localServices.launcher']?.dependencies).not.toContain('localServices.preview');
    expect(FEATURE_CATALOG['localServices.launcher']?.dependencies).not.toContain('localServices.managed');
    expect(FEATURE_CATALOG['localServices.launcher']?.representation).toBe('server');
    expect(FEATURE_CATALOG['localServices.publicPreview']?.representation).toBe('server');
  });

  it('represents the core local-services product gates on the server so a server can disable them', () => {
    // server-represented + default-allow (the server is the gate, fail-closed when missing).
    expect(FEATURE_CATALOG['localServices']?.representation).toBe('server');
    expect(FEATURE_CATALOG['localServices.inventory']?.representation).toBe('server');
    expect(FEATURE_CATALOG['localServices.managed']?.representation).toBe('server');
    expect(FEATURE_CATALOG['localServices.actions']?.representation).toBe('server');
    expect(FEATURE_CATALOG['localServices.actions.terminate']?.representation).toBe('server');
    // Exposure stays server-represented + fail-closed default-off.
    expect(FEATURE_CATALOG['localServices.preview']?.representation).toBe('server');
  });

  it('includes browser target feature ids', () => {
    expect(isFeatureId('browser')).toBe(true);
    expect(isFeatureId('browser.viewTargets')).toBe(true);
    expect(isFeatureId('browser.internal')).toBe(true);
    expect(isFeatureId('browser.sidecar')).toBe(true);
    expect(isFeatureId('browser.diagnostics')).toBe(true);
    expect(isFeatureId('browser.context')).toBe(true);
    expect(isFeatureId('browser.automation')).toBe(true);
    expect(isFeatureId('browser.automation.injectedPage')).toBe(true);
    expect(isFeatureId('browser.automation.eval')).toBe(true);
    expect(isFeatureId('browser.recording')).toBe(true);
    expect(isFeatureId('browser.recording.attachments')).toBe(true);
    expect(FEATURE_CATALOG['browser.viewTargets']?.dependencies).toEqual(['browser']);
    expect(FEATURE_CATALOG['browser.internal']?.dependencies).toEqual(['browser.viewTargets']);
    expect(FEATURE_CATALOG['browser.sidecar']?.dependencies).toEqual(['browser.internal']);
    expect(FEATURE_CATALOG['browser.diagnostics']?.dependencies).toEqual(['browser.internal']);
    expect(FEATURE_CATALOG['browser.context']?.dependencies).toEqual(['browser.internal']);
    expect(FEATURE_CATALOG['browser.automation']?.dependencies).toEqual(['browser.internal']);
    expect(FEATURE_CATALOG['browser.automation.injectedPage']?.dependencies).toEqual(['browser.automation']);
    expect(FEATURE_CATALOG['browser.automation.eval']?.dependencies).toEqual([
      'browser.automation',
      'browser.diagnostics',
    ]);
    expect(FEATURE_CATALOG['browser.recording']?.dependencies).toEqual(['browser.internal']);
    expect(FEATURE_CATALOG['browser.recording.attachments']?.dependencies).toEqual([
      'browser.recording',
      'attachments.uploads',
      'browser.context',
    ]);
  });

  it('represents browser gates on the server so the server default owner can enable or disable them', () => {
    // Core surfaces: server-represented + default-allow (server can disable for its users).
    expect(FEATURE_CATALOG['browser']?.representation).toBe('server');
    expect(FEATURE_CATALOG['browser.viewTargets']?.representation).toBe('server');
    expect(FEATURE_CATALOG['browser.internal']?.representation).toBe('server');
    // Browser capability tiers are server-represented and depend on the core browser branch.
    expect(FEATURE_CATALOG['browser.sidecar']?.representation).toBe('server');
    expect(FEATURE_CATALOG['browser.recording']?.representation).toBe('server');
    expect(FEATURE_CATALOG['browser.context']?.representation).toBe('server');
    expect(FEATURE_CATALOG['browser.diagnostics']?.representation).toBe('server');
    // Automation is a server-owned capability too: a server admin can enable/disable it independently
    // of human browsing + devtools. Its finer injectedPage/eval tiers stay client + fail-closed.
    expect(FEATURE_CATALOG['browser.automation']?.representation).toBe('server');
  });

  it('includes plugin UI tier feature ids', () => {
    expect(isFeatureId('plugins')).toBe(true);
    expect(isFeatureId('plugins.ui')).toBe(true);
    expect(isFeatureId('plugins.ui.hostedWeb')).toBe(true);
    expect(isFeatureId('plugins.ui.embeddedWebBundles')).toBe(true);
    expect(isFeatureId('plugins.ui.reactNativeBundles')).toBe(true);
    expect(isFeatureId('plugins.ui.reactNativeBundles.devHotReload')).toBe(true);
    expect(isFeatureId('plugins.ui.structuredMessages')).toBe(true);
    // Core plugin platform + UI projection gates are server-represented + default-allow.
    expect(FEATURE_CATALOG['plugins']?.representation).toBe('server');
    expect(FEATURE_CATALOG['plugins.ui']?.representation).toBe('server');
    expect(FEATURE_CATALOG['plugins.ui']?.dependencies).toEqual(['plugins']);
    expect(FEATURE_CATALOG['plugins.ui.hostedWeb']?.dependencies).toEqual(['plugins.ui']);
    expect(FEATURE_CATALOG['plugins.ui.embeddedWebBundles']?.dependencies).toEqual(['plugins.ui']);
    expect(FEATURE_CATALOG['plugins.ui.structuredMessages']?.dependencies).toEqual(['plugins.ui']);
    expect(FEATURE_CATALOG['plugins.ui.structuredMessages']?.defaultFailMode).toBe('fail_closed');
    // §4.1/§13.5.3: the plugin UI tiers are server-represented + default-ALLOW kill-switches; the
    // per-plugin install/enable/trust/runtime derivation (5.1/5.2) governs actual availability.
    expect(FEATURE_CATALOG['plugins.ui.structuredMessages']?.representation).toBe('server');
    expect(FEATURE_CATALOG['plugins.ui.reactNativeBundles']?.dependencies).toEqual(['plugins.ui']);
    expect(FEATURE_CATALOG['plugins.ui.reactNativeBundles.devHotReload']?.dependencies).toEqual([
      'plugins.ui.reactNativeBundles',
    ]);
    expect(FEATURE_CATALOG['plugins.ui.hostedWeb']?.representation).toBe('server');
    expect(FEATURE_CATALOG['plugins.ui.embeddedWebBundles']?.representation).toBe('server');
    expect(FEATURE_CATALOG['plugins.ui.reactNativeBundles']?.representation).toBe('server');
    // The finer dev-only hot-reload tier stays client + fail-closed (author affordance, §4.1).
    expect(FEATURE_CATALOG['plugins.ui.reactNativeBundles.devHotReload']?.representation).toBe('client');
    // RN-WEB-LOADER / LEDGER DEC-6: embeddedWeb is retired from the public
    // authoring story (superseded by reactNative-on-web) — no
    // `.devHotReload` child gate exists for it; the base gate stays live only
    // to govern already-installed embeddedWeb artifact rendering.
    expect(isFeatureId('plugins.ui.embeddedWebBundles.devHotReload')).toBe(false);
  });

  it('includes simulator preview feature ids', () => {
    expect(isFeatureId('devices')).toBe(true);
    expect(isFeatureId('devices.simulatorPreview')).toBe(true);
    // §4.1: server-represented + default-ALLOW (viewing your own simulator).
    expect(FEATURE_CATALOG['devices.simulatorPreview']?.representation).toBe('server');
    expect(FEATURE_CATALOG['devices.simulatorPreview']?.dependencies).toEqual([
      'devices',
      'machines.liveStream',
      'browser.viewTargets',
    ]);
  });

  it('includes sharing feature ids', () => {
    expect(isFeatureId('sharing.session')).toBe(true);
    expect(isFeatureId('sharing.public')).toBe(true);
    expect(isFeatureId('sharing.contentKeys')).toBe(true);
    expect(isFeatureId('sharing.pendingQueueV2')).toBe(true);
    expect(isFeatureId('sharing.pendingDeliveryState')).toBe(true);
    expect(FEATURE_CATALOG['sharing.pendingDeliveryState']?.representation).toBe('server');
    expect(FEATURE_CATALOG['sharing.pendingDeliveryState']?.dependencies).toEqual(['sharing.pendingQueueV2']);
    expect(FEATURE_CATALOG['sharing.pendingDeliveryState']?.defaultFailMode).toBe('fail_closed');
  });

  it('includes voice agent feature id', () => {
    expect(isFeatureId('voice.agent')).toBe(true);
  });

  it('includes daemon voice inference feature id', () => {
    expect(isFeatureId('voice.daemonInference')).toBe(true);
  });

  it('includes happier voice feature id', () => {
    expect(isFeatureId('voice.happierVoice')).toBe(true);
  });

  it('includes setup surface policy feature ids', () => {
    expect(isFeatureId('setup.relay.allowRelaySelection')).toBe(true);
    expect(isFeatureId('setup.relay.allowHappierCloud')).toBe(true);
    expect(isFeatureId('setup.relay.allowCustomRelayUrl')).toBe(true);
    expect(isFeatureId('setup.relay.allowLocalRelayHost')).toBe(true);
    expect(isFeatureId('setup.relay.allowRemoteSshRelayHost')).toBe(true);
    expect(isFeatureId('setup.relayAccess.allowTailscale')).toBe(true);
    expect(isFeatureId('setup.relayAccess.allowCloudflareTunnel')).toBe(true);
    expect(isFeatureId('setup.ssh.nativeTransport')).toBe(true);
    expect(FEATURE_CATALOG['setup.ssh.nativeTransport']?.representation).toBe('client');
    expect(FEATURE_CATALOG['setup.ssh.nativeTransport']?.dependencies).toEqual([]);
  });

  it('includes remote host management feature ids', () => {
    expect(isFeatureId('remoteHosts.management')).toBe(true);
    expect(isFeatureId('remoteHosts.secretMaterial')).toBe(true);
  });

  it('includes native terminal renderer gates with explicit dependency ordering', () => {
    expect(isFeatureId('terminal.renderer.native')).toBe(true);
    expect(isFeatureId('terminal.renderer.iosGhostty')).toBe(true);
    expect(isFeatureId('terminal.renderer.androidTermux')).toBe(true);
    expect(FEATURE_CATALOG['terminal.renderer.native']?.representation).toBe('client');
    expect(FEATURE_CATALOG['terminal.renderer.native']?.dependencies).toEqual(['terminal.transport.byteStream']);
    expect(FEATURE_CATALOG['terminal.renderer.iosGhostty']?.dependencies).toEqual(['terminal.renderer.native']);
    expect(FEATURE_CATALOG['terminal.renderer.androidTermux']?.dependencies).toEqual(['terminal.renderer.native']);
  });

  it('does not include legacy connected.services ids', () => {
    expect(isFeatureId('connected.services')).toBe(false);
    expect(isFeatureId('connected.services.quotas')).toBe(false);
  });

  it('maps every catalog entry to a known feature id', () => {
    for (const key of Object.keys(FEATURE_CATALOG)) {
      expect(isFeatureId(key)).toBe(true);
    }
  });

  it('only references known feature ids in dependencies', () => {
    for (const entry of Object.values(FEATURE_CATALOG)) {
      for (const dep of entry.dependencies) {
        expect(isFeatureId(dep)).toBe(true);
      }
    }
  });

  it('does not contain dependency cycles', () => {
    const depsById = new Map(Object.entries(FEATURE_CATALOG).map(([id, e]) => [id, e.dependencies] as const));

    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error(`cycle detected at ${id}`);
      visiting.add(id);
      const deps = depsById.get(id as any) ?? [];
      for (const dep of deps) visit(dep);
      visiting.delete(id);
      visited.add(id);
    };

    for (const id of Object.keys(FEATURE_CATALOG)) {
      visit(id);
    }
  });

  it('marks all features fail closed by default', () => {
    for (const entry of Object.values(FEATURE_CATALOG)) {
      expect(entry.defaultFailMode).toBe('fail_closed');
    }
  });
});
