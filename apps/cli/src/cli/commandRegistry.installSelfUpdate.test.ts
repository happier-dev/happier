import { describe, expect, it } from 'vitest';

import {
  commandRegistry,
  resolveCommandDispatchRegistry,
} from './commandRegistry';
import { resolveCommandSurfaceCatalog } from './commandSurfaceManifest';

describe('commandRegistry install/update aliases', () => {
  it('registers bug-report top-level command', () => {
    expect(commandRegistry['bug-report']).toBeTypeOf('function');
  });

  it('registers self-update top-level alias', () => {
    expect(commandRegistry['self-update']).toBeTypeOf('function');
  });

  it('registers install command namespace', () => {
    expect(commandRegistry.install).toBeTypeOf('function');
  });

  it('registers plugins command namespace', () => {
    expect(commandRegistry.plugins).toBeTypeOf('function');
  });

  it('registers service command namespace and daemon compatibility alias', () => {
    expect(commandRegistry.service).toBeTypeOf('function');
    expect(commandRegistry.daemon).toBeTypeOf('function');
  });

  it('registers status top-level command', () => {
    expect(commandRegistry.status).toBeTypeOf('function');
  });

  it('registers resume top-level command', () => {
    expect(commandRegistry.resume).toBeTypeOf('function');
  });

  it('registers session top-level command', () => {
    expect(commandRegistry.session).toBeTypeOf('function');
  });

  it('registers sessions top-level alias', () => {
    expect(commandRegistry.sessions).toBeTypeOf('function');
  });

  it('registers profiles command namespace + alias', () => {
    expect(commandRegistry.profiles).toBeTypeOf('function');
    expect(commandRegistry.profile).toBeTypeOf('function');
  });

  it('registers mcp command namespace', () => {
    expect(commandRegistry.mcp).toBeTypeOf('function');
  });

  it('registers machine command namespace', () => {
    expect(commandRegistry.machine).toBeTypeOf('function');
  });

  it('registers bridge command namespace', () => {
    expect(commandRegistry.bridge).toBeTypeOf('function');
  });

  it('registers tools command namespace', () => {
    expect(commandRegistry.tools).toBeTypeOf('function');
  });

  it('registers uninstall top-level command', () => {
    expect(commandRegistry.uninstall).toBeTypeOf('function');
  });

  it('registers built-in agent commands without a customAcp built-in shim', () => {
    const registry = commandRegistry as Record<string, unknown>;
    expect(registry.customAcp).toBeUndefined();
    expect(registry.kiro).toBeTypeOf('function');
  });

  it('registers the configured ACP catalog command namespace', () => {
    expect(commandRegistry['acp-catalog']).toBeTypeOf('function');
  });

  it('exposes canonical command-dispatch descriptors', () => {
    const dispatchRegistry = resolveCommandDispatchRegistry();
    const installDescriptor = dispatchRegistry.findByCommand('install');
    expect(installDescriptor).not.toBeNull();
    expect(installDescriptor).toMatchObject({
      id: 'install',
      command: 'install',
      handler: expect.any(Function),
    });
  });

  it('exposes canonical command-surface descriptors', () => {
    const surfaceCatalog = resolveCommandSurfaceCatalog();
    const installSurface = surfaceCatalog.findByCommand('install');
    expect(installSurface).not.toBeNull();
    expect(installSurface).toMatchObject({
      id: 'install',
      command: 'install',
      rootHelpLabel: 'happier install',
      rootHelpDescription: 'Install provider CLIs and helpers',
    });
  });
});
