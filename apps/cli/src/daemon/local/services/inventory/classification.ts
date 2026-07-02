export type LocalServiceProcessClassification = Readonly<{
    kind?: string;
    displayName?: string;
    confidence?: 'high' | 'medium' | 'low';
    lowSignal?: boolean;
    signals: readonly string[];
}>;

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
    { kind: 'python-http-server', displayName: 'Python HTTP server', confidence: 'high', pattern: /\bpython3?\s+-m\s+http\.server\b/i, signal: 'command:python-http-server' },
    { kind: 'react-scripts', displayName: 'React scripts', confidence: 'medium', pattern: /\breact-scripts\s+start\b/i, signal: 'command:react-scripts' },
    { kind: 'npm-dev', displayName: 'NPM dev server', confidence: 'medium', pattern: /\bnpm\s+(?:run\s+)?dev\b/i, signal: 'command:npm-dev' },
    { kind: 'package-start', displayName: 'Package start script', confidence: 'medium', pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?start\b/i, signal: 'command:package-start' },
]);

const SYSTEM_LISTENER_PATTERN = /\b(?:postgres(?:ql)?|redis-server|mysql(?:d)?|mongod|memcached)\b/i;
const CHROMIUM_CHILD_PATTERN = /--type=(?:renderer|gpu-process|gpu|utility|zygote|plugin|ppapi|broker|crashpad-handler)\b/i;
const APP_HELPER_PATTERN = /\bhelper\s+\((?:renderer|gpu|plugin|alerts)\)/i;

export function classifyLocalServiceProcess(input: Readonly<{
    command: string;
    cwd?: string;
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
                ...(lowSignal ? { lowSignal: true } : {}),
                signals: [...signals, definition.signal],
            };
        }
    }
    return {
        confidence: lowSignal ? 'low' : 'medium',
        ...(lowSignal ? { lowSignal: true } : {}),
        signals,
    };
}
