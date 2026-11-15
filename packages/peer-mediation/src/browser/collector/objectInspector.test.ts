import { describe, expect, it } from 'vitest';
import { INJECTED_EVAL_RUNTIME } from './eval.js';
import { INJECTED_OBJECT_INSPECTOR_RUNTIME } from './objectInspector.js';

describe('injected object groups', () => {
  it('looks up and releases complete group identities independently of a shared long prefix', () => {
    const results: unknown[] = [];
    const config = {
      browserSessionId: 'browser', viewId: 'view', navigationGeneration: 1,
      collector: { collectorId: 'collector', nonce: 'nonce' },
    };
    // postEnvelope is the host transport boundary; execute the real inspector and command handlers.
    const inspector = new Function('config', 'postEnvelope', `
      ${INJECTED_OBJECT_INSPECTOR_RUNTIME}
      ${INJECTED_EVAL_RUNTIME}
      return { create: toRemoteObject, properties: handleGetPropertiesCommand, release: handleReleaseCommand };
    `)(config, (envelope: { result: unknown }) => results.push(envelope.result)) as {
      create: (value: object, group: string) => { objectId: string };
      properties: (message: unknown) => void;
      release: (message: unknown) => void;
    };
    const prefix = 'inspection-group-'.repeat(20);
    const firstGroup = `${prefix}first`;
    const secondGroup = `${prefix}second`;
    const first = inspector.create({ value: 'first' }, firstGroup);
    const second = inspector.create({ value: 'second' }, secondGroup);
    const command = (kind: string, request: Record<string, unknown>) => ({
      ...config, kind,
      request: { ...request, viewId: config.viewId, navigationGeneration: config.navigationGeneration,
        tier: 'injectedPage', diagnosticsInteractionEnabled: true },
    });
    inspector.properties(command('browser.diagnostics.getPropertiesRequest', {
      propertyRequestId: 'before-release', objectGroupId: firstGroup, objectId: first.objectId,
    }));
    expect(results.at(-1)).toMatchObject({ status: 'completed', properties: [
      { name: 'value', value: { type: 'string', value: 'first' } },
    ] });

    inspector.release(command('browser.diagnostics.releaseObjectGroupRequest', {
      releaseRequestId: 'release-first', objectGroupId: firstGroup,
    }));
    inspector.properties(command('browser.diagnostics.getPropertiesRequest', {
      propertyRequestId: 'after-release', objectGroupId: firstGroup, objectId: first.objectId,
    }));
    expect(results.at(-1)).toMatchObject({ status: 'failed', errorCode: 'target_detached' });
    inspector.properties(command('browser.diagnostics.getPropertiesRequest', {
      propertyRequestId: 'retained-second', objectGroupId: secondGroup, objectId: second.objectId,
    }));
    expect(results.at(-1)).toMatchObject({ status: 'completed', properties: [
      { name: 'value', value: { type: 'string', value: 'second' } },
    ] });
  });
});
