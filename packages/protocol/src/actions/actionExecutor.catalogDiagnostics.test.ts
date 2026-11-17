import { expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionOutputDiagnostic } from './executor/actionFailureDiagnostic.js';

it.each(['ECONNRESET', 'PRIVATE_EXTERNAL_CODE'])('retains a contributed catalog boundary cause behind the public unavailable error (%s)', async code => {
  const diagnostics: ActionOutputDiagnostic[] = [];
  const executor = createActionExecutor({
    // Plugin contribution enumeration is an external boundary.
    listContributedActionDefinitions: () => { throw Object.assign(new TypeError('PRIVATE_CATALOG_RESPONSE'), { code }); },
    recordActionOutputDiagnostic: diagnostic => diagnostics.push(diagnostic),
  });
  const result = await executor.execute('action.spec.search', { query: 'example.plugin/actions/inspect' }, { surface: 'api' });
  expect(result).toEqual({ ok: false, errorCode: 'catalog_unavailable', error: 'catalog_unavailable',
    failureCause: { phase: 'dispatch', errorClass: 'Error', errorCode: 'catalog_unavailable', httpStatus: null } });
  expect(diagnostics).toMatchObject([{ source: 'action.catalog.contributed',
    failureCause: { errorClass: 'TypeError', errorCode: code === 'ECONNRESET' ? code : null } }]);
  expect(JSON.stringify([result, diagnostics])).not.toContain('PRIVATE_');
});
