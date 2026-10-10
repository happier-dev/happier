import { describe, expect, it } from 'vitest';
import { listActionSpecs } from './actionSpecs.js';
import { ActionIdSchema } from './actionIds.js';
import { getActionRequiredServerFeatureId } from './actionRequiredServerFeature.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { describeApprovalActionFields } from './actionApprovalPresentation.js';

describe('Remote host Action parity', () => {
  it('addresses relay access status by admitted Remote host instead of accepting SSH credentials', () => {
    const spec = listActionSpecs().find(row => String(row.id) === 'remote_hosts.relay.access.status');
    expect(spec).toBeDefined();
    expect(spec?.executionPlacement).toBe('client');
    expect(spec?.safety).toBe('safe');
    expect(spec?.inputSchema.safeParse({ hostId: 'host-a', expectedRevision: 4 }).success).toBe(true);
    expect(spec?.inputSchema.safeParse({ hostId: 'host-a', expectedRevision: 4, ssh: { password: 'secret' } }).success).toBe(false);
  });
  it('keeps Account catalog and SSH Actions behind the incumbent Remote host management decision', () => {
    for (const id of ['remote_hosts.list', 'remote_hosts.save', 'remote_hosts.credential.change', 'remote_hosts.personal_home.erase']) {
      expect(getActionRequiredServerFeatureId(id)).toBe('remoteHosts.management');
    }
  });
  it('admits every existing host menu operation with its addressed host', () => {
    const ids = ['remote_hosts.connect', 'remote_hosts.setup_as_machine', 'remote_hosts.relay.use',
      'remote_hosts.relay.test', 'remote_hosts.cli.install_or_update',
      'remote_hosts.daemon.install_or_update', 'remote_hosts.daemon.start', 'remote_hosts.daemon.stop',
      'remote_hosts.daemon.restart', 'remote_hosts.relay.status', 'remote_hosts.relay.install_or_update',
      'remote_hosts.relay.start', 'remote_hosts.relay.stop', 'remote_hosts.relay.restart'];
    const specs = listActionSpecs();
    for (const id of ids) {
      expect(ActionIdSchema.safeParse(id).success, id).toBe(true);
      const spec = specs.find(spec => String(spec.id) === id);
      expect(spec, id).toBeDefined();
      expect(spec?.inputSchema.safeParse({ hostId: 'host-a', expectedRevision: 4 }).success, id).toBe(true);
      expect(spec?.inputSchema.safeParse({ hostId: 'host-a', expectedRevision: 4, ssh: { target: 'other-host' } }).success, id).toBe(false);
    }
  });

  it('requires Ask first for actual relay configure and disable, with closed captured task input', () => {
    const spec = listActionSpecs().find(spec => spec.id === 'remote_hosts.relay.configure');
    if (!spec) throw new Error('Relay configuration must be declared');
    expect(spec.safety).toBe('danger');
    for (const operation of [{ kind: 'configure', config: { providerId: 'lan', url: 'https://relay.test' } }, { kind: 'disable' }]) {
      const input = { hostId: 'host-a', expectedRevision: 4, operation };
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      expect(resolveActionApprovalRouting({ actionId: spec.id, spec, input,
        context: { surface: 'ui', authority: 'present_user' } }).required).toBe(true);
      expect(resolveActionApprovalRouting({ actionId: spec.id, spec, input,
        settings: { v: 1, approvalWaivedSurfaces: { 'remote_hosts.relay.configure': ['ui'] } },
        context: { surface: 'ui', authority: 'present_user' } }).required).toBe(false);
    }
    expect(spec.inputSchema.safeParse({ hostId: 'host-a', expectedRevision: 4 }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ hostId: 'host-a', expectedRevision: 4,
      operation: { kind: 'configure', config: { providerId: 'lan', url: 'https://relay.test', token: 'unexpected' } } }).success).toBe(false);
    expect(spec.outputSchema.safeParse({ status: 'task_started', taskId: 'relay-task' }).success).toBe(true);
    expect(spec.outputSchema.safeParse({ status: 'opened', route: '/settings/remote-hosts/host-a' }).success).toBe(false);
    expect(spec.approvalInputCustody).toBe('live_only');
    expect(JSON.stringify(spec.projectObservationInput?.({ hostId: 'host-a', expectedRevision: 4,
      operation: { kind: 'configure', config: { providerId: 'cloudflareNamed', hostname: 'private.example', token: 'private-token' } } })))
      .not.toContain('private-token');
  });

  it.each([
    { kind: 'disable' },
    { kind: 'configure', config: { providerId: 'localOnly' } },
    { kind: 'configure', config: { providerId: 'lan', url: 'https://relay.test/relay' } },
    { kind: 'configure', config: { providerId: 'cloudflareNamed', hostname: 'relay.example.test', token: 'live-token' } },
  ])('presents the exact relay target and safe intent for $kind $config.providerId', operation => {
    const spec = listActionSpecs().find(spec => spec.id === 'remote_hosts.relay.configure');
    if (!spec) throw new Error('Relay configuration must be declared');
    const input = { hostId: 'host-a', expectedRevision: 4, operation };
    const observed = spec.projectObservationInput?.(input);
    const presentation = describeApprovalActionFields({ actionId: spec.id, actionArgs: observed });
    expect(presentation.rows).toContainEqual(expect.objectContaining({ path: 'hostId', value: 'host-a' }));
    expect(presentation.rows).toContainEqual(expect.objectContaining({ path: 'operation.kind', value: operation.kind }));
    expect(presentation.unrepresentable).toBeNull();
    if (operation.config) {
      expect(presentation.rows).toContainEqual(expect.objectContaining({ path: 'operation.config.providerId', value: operation.config.providerId }));
      if ('url' in operation.config) expect(presentation.rows).toContainEqual(expect.objectContaining({ path: 'operation.config.url', value: operation.config.url }));
      if ('hostname' in operation.config) expect(presentation.rows).toContainEqual(expect.objectContaining({ path: 'operation.config.hostname', value: operation.config.hostname }));
    } else {
      expect(presentation.rows.some(row => row.path.startsWith('operation.config.'))).toBe(false);
    }
    expect(JSON.stringify(observed)).not.toContain('live-token');
    expect(JSON.stringify(presentation)).not.toContain('live-token');
  });

  it('projects a credential-bearing LAN URL as its useful nonsecret address without restricting live input', () => {
    const spec = listActionSpecs().find(spec => spec.id === 'remote_hosts.relay.configure');
    if (!spec) throw new Error('Relay configuration must be declared');
    const input = { hostId: 'host-a', expectedRevision: 4, operation: { kind: 'configure',
      config: { providerId: 'lan', url: 'https://lan-user:lan-password@relay.example.test/relay?token=lan-query-secret#lan-fragment-secret' } } };
    expect(spec.inputSchema.parse(input)).toEqual(input);
    const observed = spec.projectObservationInput?.(input);
    const presentation = describeApprovalActionFields({ actionId: spec.id, actionArgs: observed });
    expect(presentation.rows).toContainEqual(expect.objectContaining({ path: 'operation.config.url', value: 'https://relay.example.test/relay' }));
    for (const secret of ['lan-user', 'lan-password', 'lan-query-secret', 'lan-fragment-secret']) {
      expect(JSON.stringify(observed)).not.toContain(secret);
      expect(JSON.stringify(presentation)).not.toContain(secret);
    }
  });

  it('requires a captured host revision and consent before erasing its Personal Home', () => {
    const spec = listActionSpecs().find(spec => String(spec.id) === 'remote_hosts.personal_home.erase');
    expect(spec).toBeDefined();
    expect(spec?.safety).toBe('danger');
    expect(spec?.executionPlacement).toBe('client');
    expect(spec?.inputSchema.safeParse({ hostId: 'host-a', expectedRevision: 4 }).success).toBe(true);
    expect(spec?.inputSchema.safeParse({ hostId: 'host-a' }).success).toBe(false);
    expect(spec?.inputSchema.safeParse({ operation: 'erase', payload: {} }).success).toBe(false);
    if (!spec) throw new Error('Remote host erase must be declared');
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec,
      input: { hostId: 'host-a', expectedRevision: 4 },
      context: { surface: 'ui', authority: 'present_user' },
    }).required).toBe(true);
    expect(resolveActionApprovalRouting({ actionId: spec.id, spec,
      input: { hostId: 'host-a', expectedRevision: 4 },
      settings: { v: 1, approvalWaivedSurfaces: { 'remote_hosts.personal_home.erase': ['ui'] } },
      context: { surface: 'ui', authority: 'present_user' },
    }).required).toBe(false);
  });

  it('redacts credential selections and remote addresses from shared observations', () => {
    const spec = listActionSpecs().find(spec => String(spec.id) === 'remote_hosts.credential.change');
    expect(spec).toBeDefined();
    expect(spec?.safety).toBe('danger');
    const input = { hostId: 'host-a', expectedRevision: 4, credential: { kind: 'password',
      resourceId: 'private-resource', expectedResourceRevision: 2 } };
    expect(spec?.inputSchema.safeParse(input).success).toBe(true);
    expect(spec?.inputSchema.safeParse({ ...input, credential: { kind: 'password', value: 'raw-secret' } }).success).toBe(false);
    expect(JSON.stringify(spec?.projectObservationInput?.({ ...input, ssh: { target: 'private-host' } })))
      .not.toContain('private-');
    const save = listActionSpecs().find(spec => String(spec.id) === 'remote_hosts.save');
    expect(save?.approvalInputCustody).toBe('live_only');
    expect(JSON.stringify(save?.projectObservationInput?.({ host: { id: 'host-a' }, expectedRevision: 4,
      savedSecretResources: [{ storedContent: { t: 'plain', v: { value: 'private-password' } } }],
    }))).not.toContain('private-password');
  });
});
