import { describe, expect, it } from 'vitest';

import { resolveDaemonServiceInstallConflictPlan } from './daemonInstallConflict.js';
import type { HappierService } from './types.js';

function createDaemonService(overrides: Partial<HappierService> = {}): HappierService {
  return {
    id: 'service:stable:cloud',
    serviceType: 'daemon',
    platform: 'linux',
    backend: 'systemd-user',
    label: 'happier-daemon.cloud',
    targetMode: 'pinned',
    verification: 'verified',
    ring: 'stable',
    instanceId: 'cloud',
    scope: 'user',
    definitionPath: '/tmp/happier-daemon.cloud.service',
    executablePath: '/tmp/happier',
    installed: true,
    running: true,
    serverUrl: 'https://cloud.example.test',
    publicServerUrl: 'https://cloud.example.test',
    ...overrides,
  };
}

describe('resolveDaemonServiceInstallConflictPlan', () => {
  it('does not treat unrelated daemon instances as conflicts by default', () => {
    const plan = resolveDaemonServiceInstallConflictPlan({
      target: {
        platform: 'linux',
        backend: 'systemd-user',
        targetMode: 'pinned',
        ring: 'stable',
        instanceId: 'cloud',
        serverUrl: 'https://cloud.example.test',
      },
      strategy: 'require-explicit',
      services: [
        createDaemonService({
          id: 'service:stable:other',
          label: 'happier-daemon.other',
          instanceId: 'other',
          serverUrl: 'https://other.example.test',
          publicServerUrl: 'https://other.example.test',
        }),
      ],
    });

    expect(plan.competingServices).toEqual([]);
    expect(plan.servicesToRemove).toEqual([]);
  });

  it('treats same-ring services for the same server URL as competing', () => {
    const plan = resolveDaemonServiceInstallConflictPlan({
      target: {
        platform: 'linux',
        backend: 'systemd-user',
        targetMode: 'pinned',
        ring: 'stable',
        instanceId: 'cloud',
        serverUrl: 'https://cloud.example.test',
      },
      strategy: 'replace-ring',
      services: [
        createDaemonService({
          id: 'service:stable:legacy',
          label: 'happier-daemon.legacy',
          instanceId: 'legacy',
          serverUrl: 'https://cloud.example.test',
          publicServerUrl: 'https://cloud.example.test',
        }),
        createDaemonService({
          id: 'service:preview:preview',
          label: 'happier-daemon.preview.preview',
          ring: 'preview',
          instanceId: 'preview',
          serverUrl: 'https://preview.example.test',
          publicServerUrl: 'https://preview.example.test',
        }),
      ],
    });

    expect(plan.competingServices.map((service) => service.label)).toEqual(['happier-daemon.legacy']);
    expect(plan.servicesToRemove.map((service) => service.label)).toEqual(['happier-daemon.legacy']);
  });

  it('treats same-instance services from another ring as competing', () => {
    const plan = resolveDaemonServiceInstallConflictPlan({
      target: {
        platform: 'linux',
        backend: 'systemd-user',
        targetMode: 'pinned',
        ring: 'stable',
        instanceId: 'cloud',
        serverUrl: 'https://cloud.example.test',
      },
      strategy: 'replace-all',
      services: [
        createDaemonService({
          id: 'service:preview:cloud',
          label: 'happier-daemon.preview.cloud',
          ring: 'preview',
        }),
      ],
    });

    expect(plan.competingServices.map((service) => service.label)).toEqual(['happier-daemon.preview.cloud']);
    expect(plan.servicesToRemove.map((service) => service.label)).toEqual(['happier-daemon.preview.cloud']);
  });

  it('treats duplicate default-following daemon services as competing', () => {
    const plan = resolveDaemonServiceInstallConflictPlan({
      target: {
        platform: 'linux',
        backend: 'systemd-user',
        targetMode: 'default-following',
        ring: null,
        instanceId: null,
        serverUrl: null,
      },
      strategy: 'replace-all',
      services: [
        createDaemonService({
          id: 'service:default:one',
          label: 'happier-daemon.default',
          targetMode: 'default-following',
          ring: null,
          instanceId: null,
          serverUrl: null,
          publicServerUrl: null,
        }),
        createDaemonService({
          id: 'service:default:two',
          label: 'happier-daemon.default.backup',
          definitionPath: '/tmp/happier-daemon.default.backup.service',
          targetMode: 'default-following',
          ring: null,
          instanceId: null,
          serverUrl: null,
          publicServerUrl: null,
        }),
      ],
    });

    expect(plan.competingServices.map((service) => service.label)).toEqual([
      'happier-daemon.default',
      'happier-daemon.default.backup',
    ]);
    expect(plan.servicesToRemove.map((service) => service.label)).toEqual([
      'happier-daemon.default',
      'happier-daemon.default.backup',
    ]);
  });

  it('treats pinned daemon services as competing when installing a default-following service', () => {
    const plan = resolveDaemonServiceInstallConflictPlan({
      target: {
        platform: 'linux',
        backend: 'systemd-user',
        targetMode: 'default-following',
        ring: null,
        instanceId: null,
        serverUrl: null,
      },
      strategy: 'require-explicit',
      services: [
        createDaemonService({
          id: 'service:stable:company',
          label: 'happier-daemon.company',
          targetMode: 'pinned',
          ring: 'stable',
          instanceId: 'company',
          serverUrl: 'https://company.example.test',
          publicServerUrl: 'https://company.example.test',
        }),
      ],
    });

    expect(plan.competingServices.map((service) => service.label)).toEqual(['happier-daemon.company']);
    expect(plan.servicesToRemove).toEqual([]);
  });

  it('treats equivalent loopback relay aliases as the same pinned server target', () => {
    const plan = resolveDaemonServiceInstallConflictPlan({
      target: {
        platform: 'linux',
        backend: 'systemd-user',
        targetMode: 'pinned',
        ring: 'stable',
        instanceId: 'stack',
        serverUrl: 'http://happier-stack.localhost:53288',
      },
      strategy: 'replace-ring',
      services: [
        createDaemonService({
          id: 'service:stable:stack-local',
          label: 'happier-daemon.stack-local',
          instanceId: 'stack-local',
          serverUrl: 'http://127.0.0.1:53288',
          publicServerUrl: 'http://localhost:53288',
        }),
      ],
    });

    expect(plan.competingServices.map((service) => service.label)).toEqual(['happier-daemon.stack-local']);
    expect(plan.servicesToRemove.map((service) => service.label)).toEqual(['happier-daemon.stack-local']);
  });
});
