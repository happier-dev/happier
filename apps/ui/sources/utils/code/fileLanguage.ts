const FILE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
    js: 'javascript',
    jsx: 'jsx',
    ts: 'typescript',
    tsx: 'tsx',
    mjs: 'javascript',
    cjs: 'javascript',
    mts: 'typescript',
    cts: 'typescript',
    py: 'python',
    html: 'html',
    htm: 'html',
    vue: 'vue',
    svelte: 'svelte',
    astro: 'astro',
    css: 'css',
    scss: 'scss',
    sass: 'sass',
    less: 'less',
    json: 'json',
    jsonc: 'jsonc',
    json5: 'json',
    md: 'markdown',
    mdx: 'mdx',
    xml: 'xml',
    svg: 'xml',
    toml: 'toml',
    ini: 'ini',
    cfg: 'ini',
    conf: 'ini',
    env: 'dotenv',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'bash',
    bash: 'bash',
    sql: 'sql',
    go: 'go',
    rust: 'rust',
    rs: 'rust',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    hh: 'cpp',
    hxx: 'cpp',
    php: 'php',
    rb: 'ruby',
    swift: 'swift',
    kt: 'kotlin',
    kts: 'kotlin',
    graphql: 'graphql',
    gql: 'graphql',
};

const FILE_LANGUAGE_BY_SPECIAL_BASENAME: Record<string, string> = {
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    gnumakefile: 'makefile',
    'cmakelists.txt': 'cmake',
    '.editorconfig': 'ini',
    '.gitconfig': 'ini',
    '.gitmodules': 'ini',
    '.npmrc': 'ini',
    '.yarnrc': 'ini',
    '.prettierrc': 'json',
    '.eslintrc': 'json',
    '.babelrc': 'json',
    '.bashrc': 'bash',
    '.bash_profile': 'bash',
    '.zshrc': 'zsh',
    '.zprofile': 'zsh',
    '.zshenv': 'zsh',
    '.zlogin': 'zsh',
    '.gitignore': 'text',
    '.gitattributes': 'text',
    '.gitkeep': 'text',
    '.dockerignore': 'text',
    'codeowners': 'codeowners',
    'tsconfig.json': 'jsonc',
    'jsconfig.json': 'jsonc',
};

function getPathExtension(path: string): string | null {
    const basename = path.split('/').pop() ?? path;
    const lastDotIndex = basename.lastIndexOf('.');
    if (lastDotIndex <= 0 || lastDotIndex >= basename.length - 1) return null;
    return basename.slice(lastDotIndex + 1).toLowerCase();
}

export function getFileLanguageFromPath(path: string): string | null {
    const normalizedPath = String(path ?? '').replace(/\\/g, '/');
    const basename = (normalizedPath.split('/').pop() ?? normalizedPath).toLowerCase();

    // Path-based special cases (not reliably captured by basename/extension alone).
    if (normalizedPath.toLowerCase().endsWith('/.ssh/config')) {
        return 'ssh-config';
    }

    const special = FILE_LANGUAGE_BY_SPECIAL_BASENAME[basename];
    if (special) return special;

    // Common dotenv variants: `.env`, `.env.local`, `.env.production`, etc.
    if (basename === '.env' || basename.startsWith('.env.')) {
        return 'dotenv';
    }

    const extension = getPathExtension(normalizedPath);
    if (!extension) return null;
    return FILE_LANGUAGE_BY_EXTENSION[extension] ?? null;
}
