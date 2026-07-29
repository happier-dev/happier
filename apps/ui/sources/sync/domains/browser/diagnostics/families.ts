import type { BrowserDiagnosticFamilyV1 } from '@happier-dev/protocol';

export const BROWSER_DIAGNOSTIC_FAMILIES: readonly BrowserDiagnosticFamilyV1[] = [
    'console',
    'pageError',
    'network',
    'elements',
    'resources',
    'storage',
    'pageInfo',
    'performance',
    'screenshot',
    'proxyTunnel',
];
