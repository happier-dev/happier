import { describe, expect, it } from 'vitest';

import { resolveCodeMirrorWebViewLanguageSpec } from './resolveCodeMirrorWebViewLanguageSpec';

describe('resolveCodeMirrorWebViewLanguageSpec', () => {
    it('maps TS/JS variants to javascript with typescript flag', () => {
        expect(resolveCodeMirrorWebViewLanguageSpec('typescript')).toEqual({ id: 'javascript', typescript: true });
        expect(resolveCodeMirrorWebViewLanguageSpec('ts')).toEqual({ id: 'javascript', typescript: true });
        expect(resolveCodeMirrorWebViewLanguageSpec('tsx')).toEqual({ id: 'javascript', typescript: true });

        expect(resolveCodeMirrorWebViewLanguageSpec('javascript')).toEqual({ id: 'javascript', typescript: false });
        expect(resolveCodeMirrorWebViewLanguageSpec('js')).toEqual({ id: 'javascript', typescript: false });
        expect(resolveCodeMirrorWebViewLanguageSpec('jsx')).toEqual({ id: 'javascript', typescript: false });
    });

    it('maps common structured languages', () => {
        expect(resolveCodeMirrorWebViewLanguageSpec('json')).toEqual({ id: 'json' });
        expect(resolveCodeMirrorWebViewLanguageSpec('jsonc')).toEqual({ id: 'json' });
        expect(resolveCodeMirrorWebViewLanguageSpec('markdown')).toEqual({ id: 'markdown' });
        expect(resolveCodeMirrorWebViewLanguageSpec('md')).toEqual({ id: 'markdown' });
        expect(resolveCodeMirrorWebViewLanguageSpec('yaml')).toEqual({ id: 'yaml' });
        expect(resolveCodeMirrorWebViewLanguageSpec('yml')).toEqual({ id: 'yaml' });
    });

    it('maps common programming languages', () => {
        expect(resolveCodeMirrorWebViewLanguageSpec('python')).toEqual({ id: 'python' });
        expect(resolveCodeMirrorWebViewLanguageSpec('css')).toEqual({ id: 'css' });
        expect(resolveCodeMirrorWebViewLanguageSpec('scss')).toEqual({ id: 'scss' });
        expect(resolveCodeMirrorWebViewLanguageSpec('less')).toEqual({ id: 'less' });
        expect(resolveCodeMirrorWebViewLanguageSpec('html')).toEqual({ id: 'html' });
        expect(resolveCodeMirrorWebViewLanguageSpec('xml')).toEqual({ id: 'xml' });
        expect(resolveCodeMirrorWebViewLanguageSpec('svg')).toEqual({ id: 'xml' });
        expect(resolveCodeMirrorWebViewLanguageSpec('sql')).toEqual({ id: 'sql' });
        expect(resolveCodeMirrorWebViewLanguageSpec('rust')).toEqual({ id: 'rust' });
        expect(resolveCodeMirrorWebViewLanguageSpec('go')).toEqual({ id: 'go' });
        expect(resolveCodeMirrorWebViewLanguageSpec('java')).toEqual({ id: 'java' });
        expect(resolveCodeMirrorWebViewLanguageSpec('cpp')).toEqual({ id: 'cpp' });
        expect(resolveCodeMirrorWebViewLanguageSpec('php')).toEqual({ id: 'php' });
    });

    it('maps common config languages to legacy modes', () => {
        expect(resolveCodeMirrorWebViewLanguageSpec('bash')).toEqual({ id: 'shell' });
        expect(resolveCodeMirrorWebViewLanguageSpec('zsh')).toEqual({ id: 'shell' });
        expect(resolveCodeMirrorWebViewLanguageSpec('dotenv')).toEqual({ id: 'shell' });
        expect(resolveCodeMirrorWebViewLanguageSpec('ssh-config')).toEqual({ id: 'shell' });
        expect(resolveCodeMirrorWebViewLanguageSpec('dockerfile')).toEqual({ id: 'dockerfile' });
        expect(resolveCodeMirrorWebViewLanguageSpec('toml')).toEqual({ id: 'toml' });
        expect(resolveCodeMirrorWebViewLanguageSpec('ini')).toEqual({ id: 'ini' });
    });

    it('returns null for empty or unknown languages', () => {
        expect(resolveCodeMirrorWebViewLanguageSpec(null)).toBe(null);
        expect(resolveCodeMirrorWebViewLanguageSpec('')).toBe(null);
        expect(resolveCodeMirrorWebViewLanguageSpec('unknown')).toBe(null);
    });
});
