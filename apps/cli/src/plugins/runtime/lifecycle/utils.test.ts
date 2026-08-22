import { describe, expect, it } from 'vitest';

import { mapDaemonModuleLoadErrorToDiagnostic, projectPluginFailureText } from './utils';

describe('plugin lifecycle failure diagnostics', () => {
    it('retains a local development source location relative to its authenticated project root', () => {
        const sourceRoot = '/Users/alice/workspaces/acme-plugin';
        const cause = new Error('Unexpected token');
        cause.stack = [
            'SyntaxError: Unexpected token',
            `    at ${sourceRoot}/src/daemon.ts:7:19`,
        ].join('\n');
        const error = new Error(
            `Failed to load plugin daemon entry '${sourceRoot}/src/daemon.ts': client_secret=source-secret`,
            { cause },
        );
        const diagnostic = mapDaemonModuleLoadErrorToDiagnostic(error, {
            localDevelopmentSourceRoot: sourceRoot,
        });

        expect(diagnostic.message).toContain('src/daemon.ts:7:19');
        expect(diagnostic.message).toContain('[REDACTED_PATH]');
        expect(diagnostic.message).not.toContain(sourceRoot);
        expect(diagnostic.message).not.toContain('source-secret');
    });

    it('does not disclose a source location outside the authenticated local development root', () => {
        const sourceRoot = '/Users/alice/workspaces/acme-plugin';
        const externalPath = '/Users/alice/private/other-project/daemon.ts';
        const cause = new Error('Unexpected token');
        cause.stack = [
            'SyntaxError: Unexpected token',
            `    at ${externalPath}:7:19`,
        ].join('\n');
        const error = new Error(
            `Failed to load plugin daemon entry '${externalPath}': Unexpected token`,
            { cause },
        );
        const diagnostic = mapDaemonModuleLoadErrorToDiagnostic(error, {
            localDevelopmentSourceRoot: sourceRoot,
        });

        expect(diagnostic.message).toContain('[REDACTED_PATH]');
        expect(diagnostic.message).not.toContain('other-project/daemon.ts:7:19');
        expect(diagnostic.message).not.toContain(externalPath);
    });

    it('projects a module-load failure through a redacted head-preserving UTF-8 bound', () => {
        const diagnostic = mapDaemonModuleLoadErrorToDiagnostic(new Error([
            'BEGIN_FAILURE client_secret=module-load-secret',
            'https://alice:module-userinfo@example.test/load?access_token=module-query-secret&safe=yes',
            '🙂'.repeat(1_200),
            'END_STACK',
        ].join(' ')));

        expect(diagnostic.message).toMatch(/^BEGIN_FAILURE/u);
        expect(diagnostic.message).not.toContain('module-load-secret');
        expect(diagnostic.message).not.toContain('module-userinfo');
        expect(diagnostic.message).not.toContain('module-query-secret');
        expect(diagnostic.message).not.toContain('END_STACK');
        expect(diagnostic.message).toContain('example.test');
        expect(diagnostic.message).toContain('safe=yes');
        expect(Buffer.byteLength(diagnostic.message, 'utf8')).toBeLessThanOrEqual(2_048);
    });

    it('uses neutral text when hostile error accessors throw during projection', () => {
        const error = new Error('unused');
        Object.defineProperties(error, {
            message: {
                configurable: true,
                get() {
                    throw new Error('BEGIN_FAILURE client_secret=accessor-secret END_STACK');
                },
            },
            code: {
                configurable: true,
                get() {
                    throw new Error('PLUGIN_DAEMON_ENTRY_MISSING');
                },
            },
        });

        expect(projectPluginFailureText(error)).toBe('Plugin operation failed');
        expect(mapDaemonModuleLoadErrorToDiagnostic(error)).toEqual({
            code: 'plugin_daemon_module_load_failed',
            message: 'Plugin operation failed',
        });
    });

    it('keeps common credential redaction while removing absolute local paths', () => {
        const diagnostic = projectPluginFailureText(new Error([
            'client_secret=path-test-secret',
            'POSIX=/Users/alice/private/plugin-generation.v1.json',
            'WINDOWS=C:\\Users\\alice\\private\\plugin-generation.v1.json',
            'UNC=\\\\server\\private\\plugin-generation.v1.json',
            'sessionCount=7 tokenCount=8 secretary=meeting-notes',
        ].join(' ')));

        expect(diagnostic).toContain('client_secret: [REDACTED]');
        expect(diagnostic).toContain('[REDACTED_PATH]');
        expect(diagnostic).not.toContain('path-test-secret');
        expect(diagnostic).not.toContain('/Users/alice/private');
        expect(diagnostic).not.toContain('C:\\Users\\alice\\private');
        expect(diagnostic).not.toContain('\\\\server\\private');
        expect(diagnostic).toContain('sessionCount=7');
        expect(diagnostic).toContain('tokenCount=8');
        expect(diagnostic).toContain('secretary=meeting-notes');
    });

    it('preserves safe web URLs while redacting a neighboring local path', () => {
        const diagnostic = projectPluginFailureText(new Error(
            'request to https://example.test/plugin/status failed at /Users/alice/private/status.json',
        ));

        expect(diagnostic).toContain('https://example.test/plugin/status');
        expect(diagnostic).toContain('[REDACTED_PATH]');
        expect(diagnostic).not.toContain('/Users/alice/private/status.json');
    });

    it('redacts colon-delimited absolute paths without treating web URLs as local paths', () => {
        const diagnostic = projectPluginFailureText(new Error([
            'POSIX=cwd:/Users/alice/private/plugin-generation.v1.json',
            'WINDOWS=cwd:C:\\Users\\alice\\private\\plugin-generation.v1.json',
            'FILE_POSIX=file:/Users/alice/private/plugin-generation.v1.json',
            'FILE_WINDOWS=file:C:/Users/alice/private/plugin-generation.v1.json',
            'WEB=https://example.test/plugin/status',
        ].join(' ')));

        expect(diagnostic).not.toContain('/Users/alice/private');
        expect(diagnostic).not.toContain('C:\\Users\\alice\\private');
        expect(diagnostic).not.toContain('C:/Users/alice/private');
        expect(diagnostic).toContain('https://example.test/plugin/status');
    });

    it('redacts forward-slash UNC paths and local file URLs', () => {
        const diagnostic = projectPluginFailureText(new Error([
            'UNC=//server/private/plugin-generation.v1.json',
            'FILE_POSIX=file:///Users/alice/private/plugin-generation.v1.json',
            'FILE_UNC=file://server/private/plugin-generation.v1.json',
        ].join(' ')));

        expect(diagnostic).toContain('[REDACTED_PATH]');
        expect(diagnostic).not.toContain('//server/private');
        expect(diagnostic).not.toContain('file:///Users/alice/private');
        expect(diagnostic).not.toContain('file://server/private');
    });

    it('redacts Windows rooted paths and complete quoted paths containing spaces', () => {
        const diagnostic = projectPluginFailureText(new Error([
            'WINDOWS_ROOT=\\Users\\alice\\private\\plugin-generation.v1.json',
            'QUOTED_POSIX="/Users/alice/Private Folder/plugin-generation.v1.json"',
            'QUOTED_WINDOWS="C:\\Users\\alice\\Private Folder\\plugin-generation.v1.json"',
        ].join(' ')));

        expect(diagnostic).not.toContain('\\Users\\alice\\private');
        expect(diagnostic).not.toContain('/Users/alice/Private Folder');
        expect(diagnostic).not.toContain('C:\\Users\\alice\\Private Folder');
        expect(diagnostic).not.toContain('Folder/plugin-generation.v1.json');
        expect(diagnostic).not.toContain('Folder\\plugin-generation.v1.json');
    });

    it('redacts complete unquoted rooted paths containing spaces and source locations while preserving the ordinary failure head', () => {
        const diagnostic = projectPluginFailureText(new Error([
            'BEGIN_FAILURE ordinary failure status remains visible',
            'POSIX=/Users/alice/Private Folder/secret-project/config.json',
            'WINDOWS=C:\\Users\\alice\\Private Folder\\secret-project\\config.json',
            'POSIX_FINAL=/Users/alice/Private Folder',
            'WINDOWS_FINAL=C:\\Users\\alice\\Private Folder',
            'POSIX_LOCATION=/Users/alice/Private Folder/secret-project/config.json:12:7',
            'WINDOWS_LOCATION=C:\\Users\\alice\\Private Folder\\secret-project\\config.json:12:7',
        ].join(' ')));

        expect(diagnostic).toContain('BEGIN_FAILURE ordinary failure status remains visible');
        expect(diagnostic).not.toContain('/Users/alice/Private Folder');
        expect(diagnostic).not.toContain('C:\\Users\\alice\\Private Folder');
        expect(diagnostic).not.toContain('Folder/secret-project/config.json');
        expect(diagnostic).not.toContain('Folder\\secret-project\\config.json');
        expect(diagnostic).not.toContain('Folder/secret-project/config.json:12:7');
        expect(diagnostic).not.toContain('Folder\\secret-project\\config.json:12:7');
        expect(diagnostic).not.toContain('POSIX_FINAL=[REDACTED_PATH] Folder');
        expect(diagnostic).not.toContain('WINDOWS_FINAL=[REDACTED_PATH] Folder');
    });

    it('keeps safe URLs and path-like substrings outside a local-path boundary', () => {
        const diagnostic = projectPluginFailureText(new Error([
            'WEB=https://example.test/Users/alice/Private Folder?safe=yes',
            'RELATIVE=prefix/Users/alice/Private Folder',
        ].join(' ')));

        expect(diagnostic).toContain('https://example.test/Users/alice/Private Folder?safe=yes');
        expect(diagnostic).toContain('prefix/Users/alice/Private Folder');
        expect(diagnostic).not.toContain('[REDACTED_PATH]');
    });
});

describe('plugin lifecycle author source locations', () => {
    const sourceRoot = '/Users/alice/workspaces/acme-plugin';

    it('publishes a structured local development source location and a rebased stack', () => {
        const cause = new Error('Unexpected token');
        cause.stack = [
            'SyntaxError: Unexpected token',
            `    at ${sourceRoot}/src/daemon.ts:7:19`,
            '    at /Users/alice/private/other-project/loader.mjs:3:1',
        ].join('\n');
        const error = new Error(
            `Failed to load plugin daemon entry '${sourceRoot}/src/daemon.ts'`,
            { cause },
        );

        const diagnostic = mapDaemonModuleLoadErrorToDiagnostic(error, {
            localDevelopmentSourceRoot: sourceRoot,
        });

        expect(diagnostic.source).toEqual({ file: 'src/daemon.ts', line: 7, column: 19 });
        expect(diagnostic.stack).toContain('src/daemon.ts:7:19');
        expect(diagnostic.stack).not.toContain(sourceRoot);
        expect(diagnostic.stack).not.toContain('/Users/alice/private/other-project/loader.mjs');
    });

    it('names the source file for a missing-module failure that carries no line or column', () => {
        const diagnostic = mapDaemonModuleLoadErrorToDiagnostic(
            new Error(`Cannot find module 'left-pad' imported from ${sourceRoot}/src/daemon.ts`),
            { localDevelopmentSourceRoot: sourceRoot },
        );

        expect(diagnostic.source).toEqual({ file: 'src/daemon.ts' });
        expect(diagnostic.message).toContain('src/daemon.ts');
        expect(diagnostic.message).not.toContain(sourceRoot);
    });

    it('publishes no source location or stack outside the local development realm', () => {
        const error = new Error(
            "Failed to load plugin daemon entry '/opt/happier/plugins/acme/dist/daemon.js': Unexpected token",
        );
        error.stack = [
            'SyntaxError: Unexpected token',
            '    at /opt/happier/plugins/acme/dist/daemon.js:7:19',
        ].join('\n');

        const diagnostic = mapDaemonModuleLoadErrorToDiagnostic(error);

        expect(diagnostic.source).toBeUndefined();
        expect(diagnostic.stack).toBeUndefined();
        expect(diagnostic.message).toContain('[REDACTED_PATH]');
        expect(diagnostic.message).not.toContain('/opt/happier/plugins');
    });

    it('publishes no source location for a failure outside the authenticated development root', () => {
        const error = new Error(
            'Failed to load plugin daemon entry: Unexpected token',
        );
        error.stack = [
            'SyntaxError: Unexpected token',
            '    at /Users/alice/private/other-project/daemon.ts:7:19',
        ].join('\n');

        const diagnostic = mapDaemonModuleLoadErrorToDiagnostic(error, {
            localDevelopmentSourceRoot: sourceRoot,
        });

        expect(diagnostic.source).toBeUndefined();
        expect(diagnostic.stack ?? '').not.toContain('other-project/daemon.ts');
    });
});
