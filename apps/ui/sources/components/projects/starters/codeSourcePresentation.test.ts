import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { describeCodeSource } from './codeSourcePresentation';

const repository = { nameWithOwner: 'acme/invoices', provider: 'GitHub' };
const observed = (rootFiles: { dockerfile: 'present' | 'absent' | 'unknown'; compose: 'present' | 'absent' | 'unknown' },
    applications: { file: string; framework: string | null; runtime: { name: string; version: string } | null }[]) => ({
    status: 'observed' as const,
    observation: { observedAtMs: 1, coverage: 'complete' as const, rootFiles, applications,
        source: { sourceId: 'source-invoices', revision: 2 } },
});

// Lab f1src Your code rows: "github.com/acme/invoices · Next.js 15 · has a Dockerfile" from the Source's last observation.
describe('Deploy an app → Your code row facts', () => {
    it('says what the repository is and what it can deploy from, as last observed', () => {
        expect(describeCodeSource(repository, observed({ dockerfile: 'present', compose: 'absent' },
            [{ file: 'package.json', framework: 'Next.js', runtime: { name: 'Node.js', version: '22' } }])))
            .toBe(`acme/invoices · Next.js · ${t('newApp.hasDockerfile')}`);
        // A Compose file is what deploys; it leads when both are there.
        expect(describeCodeSource(repository, observed({ dockerfile: 'present', compose: 'present' },
            [{ file: 'go.mod', framework: null, runtime: { name: 'Go', version: '1.23' } }])))
            .toBe(`acme/invoices · Go 1.23 · ${t('newApp.hasCompose')}`);
    });
    it('never turns unknown into absence, and keeps the provider when nothing was observed', () => {
        expect(describeCodeSource(repository, observed({ dockerfile: 'unknown', compose: 'unknown' }, [])))
            .toBe('acme/invoices');
        expect(describeCodeSource(repository, { status: 'unknown' })).toBe(t('newApp.codeSubtitle', {
            repository: 'acme/invoices', provider: 'GitHub' }));
        expect(describeCodeSource(repository, undefined)).toBe(t('newApp.codeSubtitle', {
            repository: 'acme/invoices', provider: 'GitHub' }));
    });
});
