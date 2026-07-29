import { describe, expect, it } from 'vitest';

import { readScmHostingProviderRuntimeDescriptor } from './runtimeDescriptor.js';

describe('readScmHostingProviderRuntimeDescriptor', () => {
    it('projects only host-resolved provider routing facts', () => {
        expect(readScmHostingProviderRuntimeDescriptor({
            id: 'scm.github',
            title: 'GitHub author title',
            kind: 'github',
            capabilities: ['detect'],
            displayName: 'GitHub',
            baseUrl: 'https://github.com',
            urlSafety: {
                allowedSchemes: ['https:'],
                allowedBaseUrls: ['https://github.com'],
                allowedOrigins: ['https://github.com'],
            },
        })).toEqual({
            id: 'scm.github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.com',
            urlSafety: {
                allowedSchemes: ['https:'],
                allowedBaseUrls: ['https://github.com'],
                allowedOrigins: ['https://github.com'],
            },
        });
    });

    it('does not fabricate a runtime origin from the strict author descriptor', () => {
        expect(readScmHostingProviderRuntimeDescriptor({
            id: 'github',
            title: 'GitHub',
            kind: 'github',
            capabilities: ['detect'],
        })).toBeNull();
    });

    it('rejects credential-bearing and malformed runtime URLs', () => {
        expect(readScmHostingProviderRuntimeDescriptor({
            id: 'scm.github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://user:secret@github.com',
        })).toBeNull();
        expect(readScmHostingProviderRuntimeDescriptor({
            id: 'scm.github', kind: 'github', displayName: 'GitHub', baseUrl: 'not a url',
        })).toBeNull();
        expect(readScmHostingProviderRuntimeDescriptor({
            id: 'scm.github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.com',
            urlSafety: { allowedSchemes: ['https:'], allowedOrigins: ['*'] },
        })).toBeNull();
        expect(readScmHostingProviderRuntimeDescriptor({
            id: 'scm.github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com?redirect=attacker',
        })).toBeNull();
        expect(readScmHostingProviderRuntimeDescriptor({
            id: 'scm.github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com#attacker',
        })).toBeNull();
        expect(readScmHostingProviderRuntimeDescriptor({
            id: 'scm.github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.com',
            urlSafety: { allowedSchemes: ['https:'], allowedBaseUrls: ['https://github.com/org?redirect=attacker'] },
        })).toBeNull();
    });
});
