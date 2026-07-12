import { describe, expect, it } from 'vitest';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/specs/providerSpecs';
import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';

describe('scenarioCatalog: Grok ACP stub end-to-end contracts', () => {
  it('defines create/resume, exact structured-question, and cancel/capability scenarios', async () => {
    const provider = (await loadProvidersFromCliSpecs()).find((candidate) => candidate.id === 'grok_acp_stub');
    expect(provider).toBeDefined();

    const createResume = scenarioCatalog.grok_acp_stub_auth_create_resume(provider!);
    expect(createResume.resume).toMatchObject({ metadataKey: 'grokSessionId', freshSession: true });

    const question = scenarioCatalog.grok_acp_stub_structured_question(provider!);
    expect(question.permissionAutoStructuredAnswersV1).toEqual({
      location: ['Washington, D.C.', '__proto__'],
    });
    expect(question.yolo).toBe(false);
    expect(typeof question.postSatisfy?.run).toBe('function');

    const cancel = scenarioCatalog.grok_acp_stub_cancel_and_capabilities(provider!);
    expect(typeof cancel.postSatisfy?.run).toBe('function');
    expect(typeof cancel.verify).toBe('function');
  });
});
