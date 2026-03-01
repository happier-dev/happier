import { normalizeCodeLanguageId } from '@/utils/code/normalizeCodeLanguageId';

export type CodeMirrorWebViewLanguageSpec =
    | Readonly<{ id: 'javascript'; typescript: boolean }>
    | Readonly<{ id: 'json' }>
    | Readonly<{ id: 'markdown' }>
    | Readonly<{ id: 'python' }>
    | Readonly<{ id: 'yaml' }>
    | Readonly<{ id: 'shell' }>
    | Readonly<{ id: 'dockerfile' }>
    | Readonly<{ id: 'toml' }>
    | Readonly<{ id: 'ini' }>
    | Readonly<{ id: 'css' }>
    | Readonly<{ id: 'scss' }>
    | Readonly<{ id: 'less' }>
    | Readonly<{ id: 'html' }>
    | Readonly<{ id: 'xml' }>
    | Readonly<{ id: 'sql' }>
    | Readonly<{ id: 'rust' }>
    | Readonly<{ id: 'go' }>
    | Readonly<{ id: 'java' }>
    | Readonly<{ id: 'cpp' }>
    | Readonly<{ id: 'php' }>;

export function resolveCodeMirrorWebViewLanguageSpec(
    language: string | null | undefined,
): CodeMirrorWebViewLanguageSpec | null {
    const raw = normalizeCodeLanguageId(language);
    if (!raw) return null;

    if (raw === 'typescript' || raw === 'tsx') return { id: 'javascript', typescript: true };
    if (raw === 'javascript' || raw === 'jsx') return { id: 'javascript', typescript: false };
    if (raw === 'json' || raw === 'jsonc' || raw === 'json5') return { id: 'json' };
    if (raw === 'markdown' || raw === 'mdx') return { id: 'markdown' };
    if (raw === 'python') return { id: 'python' };
    if (raw === 'yaml') return { id: 'yaml' };

    if (raw === 'bash' || raw === 'zsh' || raw === 'dotenv' || raw === 'ssh-config') return { id: 'shell' };
    if (raw === 'dockerfile') return { id: 'dockerfile' };
    if (raw === 'toml') return { id: 'toml' };
    if (raw === 'ini' || raw === 'cfg' || raw === 'conf') return { id: 'ini' };

    if (raw === 'css') return { id: 'css' };
    if (raw === 'scss') return { id: 'scss' };
    if (raw === 'less') return { id: 'less' };

    if (raw === 'html') return { id: 'html' };
    if (raw === 'xml' || raw === 'svg') return { id: 'xml' };
    if (raw === 'sql') return { id: 'sql' };
    if (raw === 'rust' || raw === 'rs') return { id: 'rust' };
    if (raw === 'go') return { id: 'go' };
    if (raw === 'java') return { id: 'java' };
    if (raw === 'cpp' || raw === 'cxx' || raw === 'cc') return { id: 'cpp' };
    if (raw === 'php') return { id: 'php' };

    return null;
}
