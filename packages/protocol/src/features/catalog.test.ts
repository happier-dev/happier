import { describe, expect, it } from 'vitest';

import { FEATURE_CATALOG, FEATURE_IDS, isFeatureId } from './catalog.js';

describe('feature catalog', () => {
  it('contains unique feature ids', () => {
    const unique = new Set(FEATURE_IDS);
    expect(unique.size).toBe(FEATURE_IDS.length);
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

  it('includes Codex app-server feature ids as client-represented runtime capabilities', () => {
    expect(isFeatureId('providers.codex.appServer.goals')).toBe(true);
    expect(isFeatureId('providers.codex.appServer.plugins')).toBe(true);
    expect(isFeatureId('providers.codex.appServer.structuredInput')).toBe(true);
    expect(isFeatureId('providers.codex.appServer.permissionProfiles')).toBe(true);
    expect(FEATURE_CATALOG['providers.codex.appServer.goals']?.representation).toBe('client');
    expect(FEATURE_CATALOG['providers.codex.appServer.goals']?.dependencies).toEqual([]);
    expect(FEATURE_CATALOG['providers.codex.appServer.plugins']?.dependencies).toContain('prompts.skills.registries');
    expect(FEATURE_CATALOG['providers.codex.appServer.structuredInput']?.dependencies).toContain('attachments.uploads');
  });

  it('includes Claude unified terminal as a client-represented runtime capability', () => {
    expect(isFeatureId('providers.claude.unifiedTerminal')).toBe(true);
    expect(FEATURE_CATALOG['providers.claude.unifiedTerminal']?.representation).toBe('client');
    expect(FEATURE_CATALOG['providers.claude.unifiedTerminal']?.dependencies).toEqual(['sessions.direct']);
  });

  it('includes the Claude unified terminal TUI runtime-control gate (fail-closed, unified-dependent)', () => {
    expect(isFeatureId('providers.claude.unifiedTerminal.tuiRuntimeControl')).toBe(true);
    expect(FEATURE_CATALOG['providers.claude.unifiedTerminal.tuiRuntimeControl']?.representation).toBe('client');
    expect(FEATURE_CATALOG['providers.claude.unifiedTerminal.tuiRuntimeControl']?.defaultFailMode).toBe('fail_closed');
    expect(FEATURE_CATALOG['providers.claude.unifiedTerminal.tuiRuntimeControl']?.dependencies).toEqual(['providers.claude.unifiedTerminal']);
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
    expect(isFeatureId('machines.tunnel.directPeer')).toBe(true);
    expect(isFeatureId('machines.tunnel.serverRouted')).toBe(true);
    expect(isFeatureId('machines.liveStream.directPeer')).toBe(true);
    expect(isFeatureId('machines.liveStream.serverRouted')).toBe(true);
    expect(isFeatureId('machines.rpc.directPeer')).toBe(true);
    const forbiddenServerRoutedRpcFeatureId = ['machines.rpc', 'serverRouted'].join('.');
    expect(isFeatureId(forbiddenServerRoutedRpcFeatureId)).toBe(false);
  });

  it('includes local service preview and public exposure feature ids', () => {
    expect(isFeatureId('localServices')).toBe(true);
    expect(isFeatureId('localServices.inventory')).toBe(true);
    expect(isFeatureId('localServices.managed')).toBe(true);
    expect(isFeatureId('localServices.preview')).toBe(true);
    expect(isFeatureId('localServices.publicPreview')).toBe(true);
    expect(FEATURE_CATALOG['localServices.inventory']?.dependencies).toEqual(['localServices']);
    expect(FEATURE_CATALOG['localServices.managed']?.dependencies).toEqual(['localServices.inventory']);
    expect(FEATURE_CATALOG['localServices.preview']?.dependencies).toEqual(['localServices.inventory']);
    expect(FEATURE_CATALOG['localServices.publicPreview']?.dependencies).toEqual(['localServices.preview']);
    expect(FEATURE_CATALOG['localServices.publicPreview']?.representation).toBe('server');
  });

  it('includes browser target feature ids', () => {
    expect(isFeatureId('browser')).toBe(true);
    expect(isFeatureId('browser.viewTargets')).toBe(true);
    expect(isFeatureId('browser.internal')).toBe(true);
    expect(isFeatureId('browser.sidecar')).toBe(true);
    expect(FEATURE_CATALOG['browser.viewTargets']?.dependencies).toEqual(['browser']);
    expect(FEATURE_CATALOG['browser.internal']?.dependencies).toEqual(['browser.viewTargets']);
    expect(FEATURE_CATALOG['browser.sidecar']?.dependencies).toEqual(['browser.internal']);
  });

  it('includes simulator preview feature ids', () => {
    expect(isFeatureId('devices')).toBe(true);
    expect(isFeatureId('devices.simulatorPreview')).toBe(true);
    expect(FEATURE_CATALOG['devices.simulatorPreview']?.representation).toBe('client');
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
