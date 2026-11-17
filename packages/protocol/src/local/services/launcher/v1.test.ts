import { describe, expect, it } from 'vitest';
import { MachineServiceIdentityV1Schema, machineServiceIdentityTupleV1 } from '../serviceIdentityV1.js';

import {
  DaemonLocalServiceLauncherSnapshotRequestV1Schema,
  DaemonLocalServiceLauncherStartRequestV1Schema,
  DaemonLocalServiceLauncherStartResponseV1Schema,
  LocalServiceLaunchTargetV1Schema,
  LocalServiceLauncherSnapshotV1Schema,
  LocalServiceEstablishmentFailureV1Schema,
} from './v1.js';

describe('LocalServiceLauncherSnapshotV1Schema', () => {
  it('retains the allocator reason and native cause in service establishment failures', () => {
    const failure = { cause: 'runtime_unavailable', reason: 'state_write_failed', causeCode: 'EACCES' };
    expect(LocalServiceEstablishmentFailureV1Schema.parse(failure)).toEqual(failure);
    expect(LocalServiceEstablishmentFailureV1Schema.safeParse({ ...failure, reason: 'invented_reason' }).success).toBe(false);
  });
  it('admits the exact adopted watch identity without inventing infrastructure authority', () => {
    const raw = { kind: 'adopted', machineId: 'machine-a', serviceId: 'watch-a', watchId: 'watch-a', watchRevision: 'watch-revision-a' };
    const identity = MachineServiceIdentityV1Schema.parse(raw);
    expect(identity).toEqual(raw);
    expect(machineServiceIdentityTupleV1(identity)).toEqual(['adopted', 'machine-a', 'watch-a', 'watch-a']);
    expect(machineServiceIdentityTupleV1(MachineServiceIdentityV1Schema.parse({ ...raw, watchRevision: 'watch-revision-b' })))
      .toEqual(machineServiceIdentityTupleV1(identity));
    for (const changed of [{ serviceId: 'other-service' }, { watchId: 'other-watch' }]) {
      expect(machineServiceIdentityTupleV1(MachineServiceIdentityV1Schema.parse({ ...raw, ...changed })))
        .not.toEqual(machineServiceIdentityTupleV1(identity));
    }
    for (const invalid of [
      { ...raw, kind: 'infrastructure' }, { ...raw, kind: 'future-service' },
      { ...raw, watchRevision: '' }, { ...raw, watchId: '' },
      { ...raw, environmentId: 'foreign-environment' }, { ...raw, composeService: 'web' },
      { ...raw, lifecyclePurpose: 'infrastructure' }, { ...raw, nativeResourceId: 'private-native-selector' },
    ]) expect(MachineServiceIdentityV1Schema.safeParse(invalid).success).toBe(false);
    const deployment = { kind: 'deployment', machineId: 'machine-a', environmentId: 'environment-a',
      environmentInstanceId: 'instance-a', composeService: 'db', serviceId: 'instance-a/db' };
    expect(machineServiceIdentityTupleV1(MachineServiceIdentityV1Schema.parse(deployment)))
      .toEqual(['deployment', 'machine-a', 'environment-a', 'instance-a', 'db', 'instance-a/db']);
    expect(MachineServiceIdentityV1Schema.safeParse({ ...deployment, serviceId: 'instance-a/web' }).success).toBe(false);
  });
  it('preserves the exact Environment service identity and rejects workspace authority on that service', () => {
    const target = { id: 'instance-a/db', source: 'managed_service', machineId: 'machine-a',
      sourceClass: { kind: 'managed_service', managedServiceId: 'native-generation-a' },
      environment: { environmentId: 'environment-a', environmentInstanceId: 'instance-a', deploymentId: 'deployment-a', composeService: 'db' },
      lifecyclePurpose: 'deployment', title: 'DB', confidence: 'high', state: 'available',
      serviceState: 'unhealthy', readiness: 'not_ready', endpointKind: 'native', actions: ['manage'] };
    expect(LocalServiceLaunchTargetV1Schema.parse(target)).toEqual(target);
    const identity = MachineServiceIdentityV1Schema.parse({ kind: 'deployment', machineId: target.machineId,
      environmentId: target.environment.environmentId, environmentInstanceId: target.environment.environmentInstanceId,
      composeService: target.environment.composeService, serviceId: target.id });
    expect(machineServiceIdentityTupleV1(identity)).toEqual(['deployment', 'machine-a', 'environment-a', 'instance-a', 'db', 'instance-a/db']);
    expect(MachineServiceIdentityV1Schema.safeParse({ ...identity, deploymentId: 'another-release' }).success).toBe(false);
    for (const changed of [
      { id: 'instance-a/web' }, { lifecyclePurpose: 'development' }, { cwd: '/repo' },
      { workspaceId: 'workspace-a' }, { sessionId: 'session-a' }, { startedByAccountId: 'actor-a' },
      { declaration: { workspaceRefId: 'workspace-a', selection: { kind: 'manifest', name: 'db' } } },
      { environment: { ...target.environment, arbitrary: true } },
    ]) expect(LocalServiceLaunchTargetV1Schema.safeParse({ ...target, ...changed }).success).toBe(false);
  });

  const acceptedCwd = `/repo/${'nested/'.repeat(320)}checkout `;
  it.each(['managed_service', 'package_script'] as const)(
    'preserves the accepted exact cwd in a qualified %s feed target', (source) => {
      const target = { id: 'actual-target', source, machineId: 'machine-a',
        workspaceId: 'accepted-workspace',
        // The canonical lookup address normalizes input; the executable cwd remains exact.
        workspace: { serverId: 'home-a', machineId: 'machine-a', workspaceId: 'accepted-workspace', rootPath: acceptedCwd.trim() },
        cwd: acceptedCwd, title: 'Worker', confidence: 'high', state: 'available', actions: [],
        declaration: { workspaceRefId: 'accepted-workspace', selection: { kind: 'manifest', name: 'worker' } },
        sourceClass: source === 'package_script'
          ? { kind: 'package_script', runTargetId: 'actual-target', packageName: 'package-a', scriptName: 'dev', cwd: acceptedCwd }
          : { kind: 'managed_service', managedServiceId: 'actual-instance' } };
      expect(LocalServiceLaunchTargetV1Schema.parse(target)).toEqual(target);
    },
  );

  it('reads the same accepted root without introducing a narrower launcher scope path', () => {
    const request = { machineId: 'machine-a', scope: 'workspace', workspaceRoot: acceptedCwd };
    expect(DaemonLocalServiceLauncherSnapshotRequestV1Schema.parse(request)).toEqual(request);
  });

  it('accepts only the explicit complete native binding projection while retaining default launcher reads', () => {
    const request = { machineId: 'machine-a', workspaceRoot: '/repo', projection: 'managed_bindings' };
    expect(DaemonLocalServiceLauncherSnapshotRequestV1Schema.parse(request)).toEqual(request);
    expect(DaemonLocalServiceLauncherSnapshotRequestV1Schema.parse({ machineId: 'machine-a' })).toEqual({ machineId: 'machine-a' });
    expect(DaemonLocalServiceLauncherSnapshotRequestV1Schema.safeParse({ ...request, projection: 'anything' }).success).toBe(false);
  });

  it('preserves observed endpoint-free Running separately from readiness and launcher availability', () => {
    const target = { id: 'managed:worker', source: 'managed_service', machineId: 'machine-a',
      sourceClass: { kind: 'managed_service', managedServiceId: 'actual-instance' },
      workspaceId: ` ${'accepted-workspace'.repeat(20)} `, cwd: '/repo', title: 'Worker', confidence: 'high',
      state: 'available', serviceState: 'running', readiness: 'not_reported', actions: ['manage'],
      startedAtMs: 10, startedByAccountId: 'actual-requester', endpointKind: 'none',
      declaration: { workspaceRefId: ` ${'accepted-workspace'.repeat(20)} `,
        selection: { kind: 'manifest', name: 'worker' } } };
    expect(LocalServiceLaunchTargetV1Schema.parse(target)).toEqual(target);
  });

  it('retains admitted execution in native bindings without inventing absent execution', () => {
    const target = LocalServiceLaunchTargetV1Schema.parse({ id: 'managed:worker', source: 'managed_service',
      machineId: 'worker-machine', sourceClass: { kind: 'managed_service', managedServiceId: 'actual-instance' },
      title: 'Worker', confidence: 'high', state: 'available', serviceState: 'running', actions: ['manage'] });
    expect(target).not.toHaveProperty('execution');
    for (const execution of ['primary', 'portable']) {
      const admitted = { ...target, execution };
      expect(LocalServiceLaunchTargetV1Schema.parse(admitted)).toEqual(admitted);
    }
    expect(LocalServiceLaunchTargetV1Schema.safeParse({ ...target, execution: 'automatic' }).success).toBe(false);
  });

  it('accepts failure diagnostics as code, severity and sanitized message only', () => {
    const target = { id: 'native-worker', source: 'managed_service', machineId: 'machine-a',
      title: 'Worker', confidence: 'high', state: 'available', serviceState: 'unhealthy', actions: ['manage'],
      diagnostics: [{ code: 'native_service_output', severity: 'info', message: 'Native worker failed [REDACTED]' }] };
    expect(LocalServiceLaunchTargetV1Schema.parse(target)).toEqual(target);
    for (const privateFields of [{ details: { env: { TOKEN: 'private' } } }, { remediation: { kind: 'retry' } }]) {
      expect(LocalServiceLaunchTargetV1Schema.safeParse({ ...target,
        diagnostics: [{ ...target.diagnostics[0], ...privateFields }] }).success).toBe(false);
    }
  });

  it('retains the source-qualified declaration on a sessionless native service target', () => {
    const target = {
      id: 'declaration:workspace-a:web', source: 'managed_service', machineId: 'machine-a',
      cwd: '/repo/app', title: 'Web', confidence: 'high', state: 'available', actions: [],
      declaration: { workspaceRefId: 'workspace-a', selection: {
        kind: 'native', source: { kind: 'native', tool: 'compose', file: 'compose.yaml', target: 'web' },
      } },
    };
    expect(LocalServiceLaunchTargetV1Schema.parse(target)).toEqual(target);
  });

  it('parses launch targets that reuse browser view targets for previews', () => {
    const parsed = LocalServiceLauncherSnapshotV1Schema.parse({
      v: 1,
      machineId: 'machine-a',
      sessionId: 'session-a',
      updatedAt: 1_000,
      targets: [{
        id: 'inventory:entry-a',
        source: 'inventory_entry',
        machineId: 'machine-a',
        sessionId: 'session-a',
        title: 'Local Vite App',
        subtitle: 'web · localhost:5173',
        kind: 'vite',
        commandPreview: 'npm run dev',
        confidence: 'high',
        state: 'available',
        actions: ['open_preview', 'register_preview'],
        browserTarget: {
          kind: 'localServicePreview',
          targetId: 'preview-a',
          sessionId: 'session-a',
          machineId: 'machine-a',
          display: {
            title: 'Local Vite App',
            addressLabel: 'localhost:5173',
            folderLabel: 'web',
            iconToken: 'vite',
          },
        },
      }],
    });

    expect(parsed.targets[0]?.browserTarget?.kind).toBe('localServicePreview');
    expect(parsed.targets[0]?.actions).toEqual(['open_preview', 'register_preview']);
  });

  it('accepts terminal URL and workspace file asset source classes as disabled launch targets', () => {
    const parsed = LocalServiceLauncherSnapshotV1Schema.parse({
      v: 1,
      machineId: 'machine-a',
      sessionId: 'session-a',
      updatedAt: 1_000,
      targets: [
        {
          id: 'terminal-url:candidate-a',
          source: 'terminal_url',
          machineId: 'machine-a',
          sessionId: 'session-a',
          title: 'localhost:5173/login',
          subtitle: 'Terminal output candidate',
          kind: 'terminal_url',
          confidence: 'low',
          state: 'unavailable',
          unavailableReason: 'terminal_url_unresolved',
          actions: [],
        },
        {
          id: 'workspace-file-asset:asset-a',
          source: 'workspace_file_asset',
          machineId: 'machine-a',
          sessionId: 'session-a',
          workspaceId: 'workspace-a',
          title: 'App screenshot',
          subtitle: 'image/png',
          kind: 'workspace_file_asset',
          confidence: 'medium',
          state: 'unavailable',
          unavailableReason: 'workspace_file_asset_preview_unavailable',
          actions: [],
        },
      ],
    });

    expect(parsed.targets.map((target) => [target.source, target.state, target.actions])).toEqual([
      ['terminal_url', 'unavailable', []],
      ['workspace_file_asset', 'unavailable', []],
    ]);
  });

  it('parses terminal URL source class metadata without enabling raw URL opens', () => {
    const parsed = LocalServiceLaunchTargetV1Schema.parse({
      id: 'terminal-url:candidate-a',
      source: 'terminal_url',
      sourceClass: {
        kind: 'terminal_url',
        sourceId: 'candidate-a',
        addressLabel: 'localhost:5173/login',
        host: 'localhost',
        port: 5173,
      },
      machineId: 'machine-a',
      sessionId: 'session-a',
      title: 'localhost:5173/login',
      subtitle: 'Terminal output candidate',
      kind: 'terminal_url',
      confidence: 'low',
      state: 'unavailable',
      unavailableReason: 'terminal_url_unresolved',
      actions: [],
    });

    expect(parsed.sourceClass).toEqual({
      kind: 'terminal_url',
      sourceId: 'candidate-a',
      addressLabel: 'localhost:5173/login',
      host: 'localhost',
      port: 5173,
    });
    expect(parsed.actions).toEqual([]);
  });

  it('parses workspace file asset source class metadata for owner-produced safe refs', () => {
    const parsed = LocalServiceLaunchTargetV1Schema.parse({
      id: 'workspace-file-asset:asset-ref-a',
      source: 'workspace_file_asset',
      sourceClass: {
        kind: 'workspace_file_asset',
        sourceId: 'asset-candidate-a',
        assetRef: 'asset-ref-a',
        mediaType: 'image/png',
      },
      machineId: 'machine-a',
      sessionId: 'session-a',
      workspaceId: 'workspace-a',
      title: 'App screenshot',
      subtitle: 'image/png',
      kind: 'workspace_file_asset',
      confidence: 'medium',
      state: 'unavailable',
      unavailableReason: 'workspace_file_asset_preview_unavailable',
      actions: [],
    });

    expect(parsed.sourceClass).toEqual({
      kind: 'workspace_file_asset',
      sourceId: 'asset-candidate-a',
      assetRef: 'asset-ref-a',
      mediaType: 'image/png',
    });
  });

  it('allows detected-service terminate as a launch target affordance', () => {
    const parsed = LocalServiceLaunchTargetV1Schema.parse({
      id: 'inventory:inventory-a',
      source: 'inventory_entry',
      sourceClass: {
        kind: 'inventory_entry',
        inventoryEntryId: 'inventory-a',
      },
      machineId: 'machine-a',
      sessionId: 'session-a',
      title: 'Local app',
      subtitle: 'localhost:5173',
      confidence: 'high',
      state: 'available',
      actions: ['open', 'terminate_detected'],
      browserTarget: {
        kind: 'externalUrl',
        targetId: 'inventory-loopback:inventory-a',
        url: 'http://127.0.0.1:5173/',
      },
    });

    expect(parsed.actions).toEqual(['open', 'terminate_detected']);
  });

  it('rejects source class metadata that disagrees with the launch target source', () => {
    expect(() => LocalServiceLaunchTargetV1Schema.parse({
      id: 'terminal-url:candidate-a',
      source: 'terminal_url',
      sourceClass: {
        kind: 'workspace_file_asset',
        sourceId: 'asset-candidate-a',
        assetRef: 'asset-ref-a',
      },
      machineId: 'machine-a',
      title: 'localhost:5173/login',
      confidence: 'low',
      state: 'unavailable',
      unavailableReason: 'terminal_url_unresolved',
      actions: [],
    })).toThrow();
  });
});

describe('DaemonLocalServiceLauncherStartV1 schemas', () => {
  it('accepts a reviewed exact execution choice, but not an unenrolled creation selection', () => {
    const request = { machineId: 'primary', targetId: 'project:web',
      choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'enrolled-worker' } } };
    expect(DaemonLocalServiceLauncherStartRequestV1Schema.safeParse(request).success).toBe(true);
    expect(DaemonLocalServiceLauncherStartRequestV1Schema.safeParse({ ...request,
      choice: { kind: 'managed_creation', presetId: 'preset' },
    }).success).toBe(false);
  });

  it('requires a machine-bound launcher target start request', () => {
    expect(DaemonLocalServiceLauncherStartRequestV1Schema.parse({
      machineId: 'machine-a',
      targetId: 'managed:web',
      sessionId: 'session-a',
      workspaceId: 'workspace-a',
    })).toEqual({
      machineId: 'machine-a',
      targetId: 'managed:web',
      sessionId: 'session-a',
      workspaceId: 'workspace-a',
    });

    expect(DaemonLocalServiceLauncherStartRequestV1Schema.safeParse({
      machineId: 'machine-a',
    }).success).toBe(false);
  });

  it('binds start responses to the requested machine and target', () => {
    const parsed = DaemonLocalServiceLauncherStartResponseV1Schema.parse({
      protocolVersion: 1,
      machineId: 'machine-a',
      targetId: 'managed:web',
      status: 'denied',
      reasonCode: 'launcher_start_unsupported',
      snapshot: {
        v: 1,
        machineId: 'machine-a',
        sessionId: 'session-a',
        updatedAt: 4_000,
        targets: [],
      },
    });

    expect(parsed).toMatchObject({
      machineId: 'machine-a',
      targetId: 'managed:web',
      status: 'denied',
      reasonCode: 'launcher_start_unsupported',
    });

    expect(DaemonLocalServiceLauncherStartResponseV1Schema.safeParse({
      protocolVersion: 1,
      machineId: 'machine-a',
      targetId: 'managed:web',
      status: 'failed',
      snapshot: {
        v: 1,
        machineId: 'machine-a',
        updatedAt: 4_000,
        targets: [],
      },
    }).success).toBe(false);

    expect(DaemonLocalServiceLauncherStartResponseV1Schema.safeParse({
      protocolVersion: 1,
      machineId: 'machine-a',
      targetId: 'managed:web',
      status: 'succeeded',
      snapshot: {
        v: 1,
        machineId: 'machine-b',
        updatedAt: 4_000,
        targets: [],
      },
    }).success).toBe(false);
  });
});

describe('LocalServiceLaunchTargetV1Schema open action (local open)', () => {
  it('accepts an available loopback inventory entry advertising the open action with an externalUrl target', () => {
    const parsed = LocalServiceLaunchTargetV1Schema.parse({
      id: 'inventory:entry-loopback',
      source: 'inventory_entry',
      machineId: 'machine-a',
      title: 'Local Vite App',
      subtitle: 'localhost:5173',
      confidence: 'high',
      state: 'available',
      actions: ['open'],
      browserTarget: {
        kind: 'externalUrl',
        targetId: 'inventory-loopback:entry-loopback',
        url: 'http://127.0.0.1:5173/',
        display: { title: 'Local Vite App', addressLabel: 'localhost:5173' },
      },
    });
    expect(parsed.actions).toEqual(['open']);
    expect(parsed.browserTarget?.kind).toBe('externalUrl');
  });
});

describe('DaemonLocalServiceLauncherSnapshotRequestV1Schema scope', () => {
  it('accepts an explicit machine scope and a session-less workspaceRoot', () => {
    expect(DaemonLocalServiceLauncherSnapshotRequestV1Schema.parse({
      machineId: 'machine-a',
      scope: 'machine',
      sessionId: 'session-a',
    })).toEqual({ machineId: 'machine-a', scope: 'machine', sessionId: 'session-a' });

    expect(DaemonLocalServiceLauncherSnapshotRequestV1Schema.parse({
      machineId: 'machine-a',
      scope: 'workspace',
      workspaceRoot: '/Users/dev/proj',
    })).toEqual({ machineId: 'machine-a', scope: 'workspace', workspaceRoot: '/Users/dev/proj' });
  });

  it('rejects an unknown scope', () => {
    expect(DaemonLocalServiceLauncherSnapshotRequestV1Schema.safeParse({
      machineId: 'machine-a',
      scope: 'global',
    }).success).toBe(false);
  });
});

describe('LocalServiceLaunchTargetV1Schema', () => {
  it('requires an unavailable reason when stale targets disable actions', () => {
    expect(() => LocalServiceLaunchTargetV1Schema.parse({
      id: 'recent:entry-a',
      source: 'recent',
      machineId: 'machine-a',
      title: 'Stale service',
      confidence: 'low',
      state: 'unavailable',
      actions: [],
    })).toThrow();

    expect(LocalServiceLaunchTargetV1Schema.parse({
      id: 'recent:entry-a',
      source: 'recent',
      machineId: 'machine-a',
      title: 'Stale service',
      confidence: 'low',
      state: 'unavailable',
      unavailableReason: 'stale_service',
      actions: [],
    }).unavailableReason).toBe('stale_service');
  });
});
