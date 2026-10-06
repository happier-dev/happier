import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('emits real locale declarations while retaining exact keys and interpolation parameters', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const uiDir = join(repoRoot, 'apps/ui');
    const fixture = mkdtempSync(join(repoRoot, '.translation-types-'));
    const locales = ['en', 'ca', 'de', 'es', 'fr', 'it', 'ja', 'pl', 'pt', 'ru', 'zh-Hans', 'zh-Hant'];
    const consumerPath = join(fixture, 'consumer.ts');
    const consumer = `import { en } from ${JSON.stringify(join(uiDir, 'sources/text/translations/en'))};
import { ca } from ${JSON.stringify(join(uiDir, 'sources/text/translations/ca'))};
import { zhHans } from ${JSON.stringify(join(uiDir, 'sources/text/translations/zh-Hans'))};
import { defineTranslations } from ${JSON.stringify(join(uiDir, 'sources/text/_types'))};
export const title: string = en.sessionBoard.views.reconciled({ title: 'Board' });
export const key: keyof typeof en.sessionBoard.views = 'reconciled';
export const installation: string = en.identityAdministration.githubRemoveInstallationFor({ name: 'installation' });
export const identityKey: keyof typeof en.identityAdministration = 'githubRemoveInstallationFor';
export const localizedInstallation: string = ca.identityAdministration.githubRemoveInstallationFor({ name: 'installation' });
export const localizedIdentityKey: keyof typeof ca.identityAdministration = 'githubRemoveInstallationFor';
const referenced: { value: string; optional?: string } = { value: 'initial' };
const interpolate = ({ count }: { count: number }): number => count;
const authoredValues = { label: 'initial', referenced, interpolate, tuple: ['first', 'second'] } as const;
const authored = defineTranslations(authoredValues);
type ExpectedCarrier = {
    readonly label: string;
    readonly referenced: { value: string; optional?: string };
    readonly interpolate: typeof interpolate;
    readonly tuple: readonly [string, string];
};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export const preservesCarrier: Equal<typeof authored, ExpectedCarrier> = true;
export const preservesLocalizedFunctionReturn: Equal<ReturnType<typeof zhHans.newSession.worktree.statusPill.changesSuffix>, string> = true;
authored.referenced.value = 'updated';
authored.referenced.optional = 'present';
`;
    try {
        const config = {
            extends: join(uiDir, 'tsconfig.json'),
            compilerOptions: {
                noEmit: false,
                declaration: true,
                emitDeclarationOnly: true,
                incremental: false,
                rootDir: repoRoot,
                outDir: join(fixture, 'declarations'),
            },
            files: [...locales.map((locale) => join(uiDir, `sources/text/translations/${locale}.ts`)), consumerPath],
            include: [],
            exclude: [],
        };
        writeFileSync(join(fixture, 'tsconfig.json'), JSON.stringify(config));
        const run = () => spawnSync(process.execPath, [
            join(repoRoot, 'scripts/workspaces/runTypeScriptCli.mjs'),
            '--project', join(fixture, 'tsconfig.json'), '--pretty', 'false',
        ], { cwd: repoRoot, encoding: 'utf8' });
        writeFileSync(consumerPath, consumer);
        const emitted = run();
        expect(emitted.status, emitted.stdout + emitted.stderr).toBe(0);
        const declaration = readFileSync(join(fixture, 'declarations/apps/ui/sources/text/translations/en.d.ts'), 'utf8');
        expect(declaration.length).toBeGreaterThan(0);

        const declarationConsumer = ['translations/en', 'translations/ca', 'translations/zh-Hans', '_types'].reduce((text, module) => text.replace(
            JSON.stringify(join(uiDir, 'sources/text', module)),
            JSON.stringify(join(fixture, 'declarations/apps/ui/sources/text', module)),
        ), consumer);
        writeFileSync(join(fixture, 'tsconfig.json'), JSON.stringify({ ...config, files: [consumerPath] }));
        writeFileSync(consumerPath, declarationConsumer + `
en.sessionBoard.views.reconciled({ title: 42 });
export const invalid: keyof typeof en.sessionBoard.views = 'not-a-key';
en.identityAdministration.githubRemoveInstallationFor({ name: 42 });
export const invalidIdentity: keyof typeof en.identityAdministration = 'not-a-key';
ca.identityAdministration.githubRemoveInstallationFor({ name: 42 });
export const invalidLocalizedIdentity: keyof typeof ca.identityAdministration = 'not-a-key';
authored.interpolate({ count: 'one' });
export const invalidInterpolationReturn: string = authored.interpolate({ count: 1 });
authored.label = 'changed';
`);
        const rejected = run();
        expect(rejected.status).not.toBe(0);
        expect((rejected.stdout + rejected.stderr).match(/consumer\.ts.*TS2322/gu)).toHaveLength(8);
        expect((rejected.stdout + rejected.stderr).match(/consumer\.ts.*TS2540/gu)).toHaveLength(1);
    } finally {
        rmSync(fixture, { recursive: true, force: true });
    }
});
