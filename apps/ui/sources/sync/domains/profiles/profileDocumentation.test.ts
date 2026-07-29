import { describe, expect, it } from 'vitest';

import { getBuiltInProfileDocumentation } from './profileDocumentation';

describe('getBuiltInProfileDocumentation', () => {
    it('does not expose retired Gemini machine-login setup documentation', () => {
        expect(getBuiltInProfileDocumentation('gemini')).toBeNull();
    });

    it('does not expose retired machine-login or provider-like profile setup documentation', () => {
        for (const id of ['anthropic', 'codex', 'deepseek', 'zai', 'openai']) {
            expect(getBuiltInProfileDocumentation(id)).toBeNull();
        }
    });

    it('documents supported Gemini API-key and Vertex profiles', () => {
        expect(getBuiltInProfileDocumentation('gemini-api-key')).toEqual(expect.objectContaining({
            environmentVariables: expect.arrayContaining([
                expect.objectContaining({ name: 'GEMINI_API_KEY', isSecret: true }),
            ]),
        }));
        expect(getBuiltInProfileDocumentation('gemini-vertex')).toEqual(expect.objectContaining({
            environmentVariables: expect.arrayContaining([
                expect.objectContaining({ name: 'GOOGLE_GENAI_USE_VERTEXAI', isSecret: false }),
                expect.objectContaining({ name: 'GOOGLE_CLOUD_PROJECT', isSecret: false }),
                expect.objectContaining({ name: 'GOOGLE_CLOUD_LOCATION', isSecret: false }),
            ]),
        }));
    });
});
