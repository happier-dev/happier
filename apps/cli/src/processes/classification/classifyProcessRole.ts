import { redactProcessCommand } from '@/processes/redaction/redactProcessCommand';

export type LocalServiceProcessClassification = Readonly<{
    kind?: string;
    displayName?: string;
    confidence?: 'high' | 'medium' | 'low';
    lowSignal?: boolean;
    role?: ProcessRole;
    browserEngine?: 'chromium' | 'firefox' | 'webkit';
    browserHelper?: boolean;
    driverLabel?: string;
    signals: readonly string[];
}>;

export type ProcessRole = 'agent' | 'tool_shell' | 'test_runner' | 'type_checker' | 'dev_server'
    | 'language_server' | 'mcp_server' | 'browser' | 'database';

const DEV_SERVER_PATTERNS: readonly Readonly<{
    kind: string;
    displayName: string;
    confidence: 'high' | 'medium';
    pattern: RegExp;
    signal: string;
}>[] = Object.freeze([
    { kind: 'vite', displayName: 'Vite', confidence: 'high', pattern: /\bvite(?:\.js)?\b/i, signal: 'command:vite' },
    { kind: 'next', displayName: 'Next.js', confidence: 'high', pattern: /\bnext\s+dev\b/i, signal: 'command:next' },
    { kind: 'nuxt', displayName: 'Nuxt', confidence: 'high', pattern: /\bnuxt\b/i, signal: 'command:nuxt' },
    { kind: 'astro', displayName: 'Astro', confidence: 'high', pattern: /\bastro\b/i, signal: 'command:astro' },
    { kind: 'expo', displayName: 'Expo', confidence: 'high', pattern: /\bexpo\s+(?:start|serve)\b/i, signal: 'command:expo' },
    { kind: 'webpack', displayName: 'Webpack dev server', confidence: 'high', pattern: /\bwebpack-dev-server\b/i, signal: 'command:webpack' },
    { kind: 'parcel', displayName: 'Parcel', confidence: 'high', pattern: /\bparcel\b/i, signal: 'command:parcel' },
    { kind: 'uvicorn', displayName: 'Uvicorn', confidence: 'high', pattern: /\buvicorn\b/i, signal: 'command:uvicorn' },
    { kind: 'flask', displayName: 'Flask', confidence: 'high', pattern: /\bflask\s+run\b/i, signal: 'command:flask' },
    { kind: 'django', displayName: 'Django', confidence: 'high', pattern: /\bmanage\.py\s+runserver\b/i, signal: 'command:django' },
    { kind: 'laravel', displayName: 'Laravel', confidence: 'high', pattern: /\bartisan\s+serve\b/i, signal: 'command:laravel' },
    { kind: 'rails', displayName: 'Rails', confidence: 'high', pattern: /\brails\s+(?:s|server)\b/i, signal: 'command:rails' },
    { kind: 'go', displayName: 'Go server', confidence: 'medium', pattern: /\bgo\s+run\b/i, signal: 'command:go-run' },
    { kind: 'cargo', displayName: 'Cargo server', confidence: 'medium', pattern: /\bcargo\s+run\b/i, signal: 'command:cargo-run' },
    { kind: 'dotnet', displayName: '.NET server', confidence: 'medium', pattern: /\bdotnet\s+(?:run|watch)\b/i, signal: 'command:dotnet' },
    { kind: 'deno', displayName: 'Deno server', confidence: 'medium', pattern: /\bdeno\s+(?:run|task)\b/i, signal: 'command:deno' },
    { kind: 'php', displayName: 'PHP server', confidence: 'high', pattern: /\bphp\s+-S\b/i, signal: 'command:php' },
    { kind: 'python-http-server', displayName: 'Python HTTP server', confidence: 'high', pattern: /\bpython3?(?:\.exe)?\s+(?:-u\s+)*(?:-m\s+http\.server\b|-c\s+[\s\S]*\bhttp\.server\.(?:Threading)?HTTPServer\s*\()/i, signal: 'command:python-http-server' },
    { kind: 'react-scripts', displayName: 'React scripts', confidence: 'medium', pattern: /\breact-scripts\s+start\b/i, signal: 'command:react-scripts' },
    { kind: 'npm-dev', displayName: 'NPM dev server', confidence: 'medium', pattern: /\bnpm\s+(?:run\s+)?dev\b/i, signal: 'command:npm-dev' },
    { kind: 'package-start', displayName: 'Package start script', confidence: 'medium', pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?start\b/i, signal: 'command:package-start' },
]);

const SYSTEM_LISTENER_PATTERN = /\b(?:postgres(?:ql)?|redis-server|mysql(?:d)?|mongod|memcached)\b/i;
const CHROMIUM_CHILD_PATTERN = /--type=(?:renderer|gpu-process|gpu|utility|zygote|plugin|ppapi|broker|crashpad-handler)\b/i;
const APP_HELPER_PATTERN = /\bhelper\s+\((?:renderer|gpu|plugin|alerts)\)/i;

export function classifyProcessRole(input: Readonly<{
    command: string;
    cwd?: string;
    agentExecutables?: readonly Readonly<{ name: string; executable: string }>[];
    mcpServers?: readonly Readonly<{ name: string; executable: string }>[];
    ancestors?: readonly Readonly<{ command: string }>[];
}>): LocalServiceProcessClassification {
    const signals: string[] = [];
    let lowSignal = false;
    if (CHROMIUM_CHILD_PATTERN.test(input.command)) {
        lowSignal = true;
        signals.push('noise:chromium-child');
    }
    if (APP_HELPER_PATTERN.test(input.command)) {
        lowSignal = true;
        signals.push('noise:app-helper');
    }
    if (SYSTEM_LISTENER_PATTERN.test(input.command)) {
        lowSignal = true;
        signals.push('noise:system-listener');
    }
    for (const definition of DEV_SERVER_PATTERNS) {
        if (definition.pattern.test(input.command)) {
            return {
                kind: definition.kind,
                displayName: definition.displayName,
                confidence: definition.confidence,
                role: 'dev_server',
                ...(lowSignal ? { lowSignal: true } : {}),
                signals: [...signals, definition.signal],
            };
        }
    }
    const command = input.command;
    const executableMatch = (executable: string) => command.split(/\s+/u).some(arg => {
        const name = arg.replace(/^['"]|['"]$/gu, '').split(/[\\/]/u).at(-1);
        return name === executable || name === `${executable}.exe`;
    });
    const agent = input.agentExecutables?.find(item => executableMatch(item.executable));
    const mcp = input.mcpServers?.find(item => executableMatch(item.executable));
    const browserEngine = /\b(?:chrom(?:e|ium)|msedge|playwright.*chromium)\b/iu.test(command) ? 'chromium'
        : /\bfirefox\b/iu.test(command) ? 'firefox' : /\b(?:webkit|safari)\b/iu.test(command) ? 'webkit' : undefined;
    const role: ProcessRole | undefined = agent ? 'agent' : mcp ? 'mcp_server'
        : /\b(?:vitest|jest|pytest|playwright\s+test|mocha)\b/iu.test(command) ? 'test_runner' : browserEngine ? 'browser'
        : SYSTEM_LISTENER_PATTERN.test(command) ? 'database'
        : /\b(?:tsc|tsgo|mypy|pyright)\b/iu.test(command) ? 'type_checker'
        : /\b(?:typescript-language-server|rust-analyzer|gopls|clangd)\b/iu.test(command) ? 'language_server'
        : /(?:^|[\s/\\])(?:bash|zsh|sh|fish|powershell|pwsh|cmd|ssh|tmux)(?:\.exe)?(?:\s|$)/iu.test(command) ? 'tool_shell' : undefined;
    const driver = input.ancestors?.find(item => /\b(?:playwright|vitest|jest|pytest)\b/iu.test(item.command));
    return {
        confidence: lowSignal ? 'low' : 'medium',
        ...(lowSignal ? { lowSignal: true } : {}),
        ...(role ? { role } : {}),
        ...(agent || mcp ? { displayName: (agent ?? mcp)?.name } : {}),
        ...(role === 'browser' && browserEngine ? { browserEngine, browserHelper: CHROMIUM_CHILD_PATTERN.test(command) || APP_HELPER_PATTERN.test(command) } : {}),
        ...(driver ? { driverLabel: redactProcessCommand(driver.command) } : {}),
        signals,
    };
}
