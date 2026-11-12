import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec, PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_IDS } from '@happier-dev/protocol/actions/actionSpecs';
import { handleActionsCommand } from './actions';

afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

it('reports mounted plugin callers truthfully through actions get while retaining ordinary CLI Actions', async () => {
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
    output += String(chunk);
    const callback = args.find(argument => typeof argument === 'function');
    if (typeof callback === 'function') callback();
    return true;
  });
  const executor = createActionExecutor({});
  for (const id of ['sessions.external.materialize.start', 'machines.list', ...PLUGIN_PROVENANCE_ONLY_API_EXCLUSION_ACTION_IDS] as const) {
    output = '';
    await handleActionsCommand(['get', id, '--json'], {
      readCredentialsFn: async () => ({ token: 'fixture', encryption: null, credentialProvenance: 'stored_session' }),
      createExecutorFn: () => ({ ...executor, resolveSessionTarget: async sessionId => ({ ok: true as const, sessionId }) }),
    });
    const envelope = JSON.parse(output);
    if (id === 'machines.list') {
      expect(envelope.ok, id).toBe(true);
      expect(envelope.data.actionSpec.surfaces.cli).toBe(true);
    } else {
      expect(envelope).toMatchObject({ ok: false, error: { code: 'action_disabled', details: {
        reason: 'unsupported_surface', surface: 'cli', remedy: expect.stringContaining('host-mounted import'),
      } } });
      expect(envelope.error.details.availableSurfaces, id).not.toContain('cli');
      expect(getActionSpec(id).surfaces.cli, id).toBe(false);
      expect(getActionSpec(id).cli, id).toBeUndefined();
      process.exitCode = undefined;
    }
  }
});

it('explains the supported host-mounted import in Action invoke help without authentication', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const readCredentialsFn = vi.fn();
  await handleActionsCommand(['invoke', 'sessions.external.materialize.start', '--help'], { readCredentialsFn });
  expect(log.mock.calls.flat().join('\n')).toContain('host-mounted import');
  expect(readCredentialsFn).not.toHaveBeenCalled();
});
