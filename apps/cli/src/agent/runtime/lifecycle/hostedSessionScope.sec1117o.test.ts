import { describe, expect, it } from 'vitest';
import { bindHostedSessionProjectFilesSource, readHostedSessionScope, runInHostedSessionScope } from './hostedSessionScope';

describe('Project files clone source custody', () => {
    it('retains the Session recipe source in host runtime scope', () => {
        const source = {
            provider: { id: 'github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'happier-dev/project', cloneUrl: 'https://github.com/happier-dev/project.git' },
            protocol: 'https' as const,
        };
        const observed = runInHostedSessionScope({ environment: {} }, () => {
            bindHostedSessionProjectFilesSource(source);
            return readHostedSessionScope()?.projectFilesSource;
        });
        expect(observed).toEqual(source);
    });
});
