import { describe, expect, expectTypeOf, it } from 'vitest';

import {
    defineLocalService,
    HAPPIER_LOCAL_SERVICE_ENV,
    type LocalServiceDeclarationV1,
    type LocalServicesRuntimeServiceV1,
} from './localServices.js';

describe('defineLocalService', () => {
    it('preserves typed managed local-service declarations', () => {
        const declaration = defineLocalService({
            id: 'web',
            launch: { kind: 'binary', executablePath: '/bin/sh', args: ['-lc', 'npm run dev'] },
            launchMode: { kind: 'detectAfterLaunch', minimumConfidence: 'medium' },
            hostPolicy: { kind: 'loopback' },
            name: { strategy: 'derived', base: 'web' },
            healthCheck: { kind: 'none' },
            restart: { kind: 'never' },
            cleanup: { staleAfterMs: 30_000 },
        });

        expect(declaration.launchMode.kind).toBe('detectAfterLaunch');
        expectTypeOf(declaration).toMatchTypeOf<LocalServiceDeclarationV1>();
    });

    it('exports environment keys from one SDK owner', () => {
        expect(HAPPIER_LOCAL_SERVICE_ENV.PORT).toBe('PORT');
        expect(HAPPIER_LOCAL_SERVICE_ENV.PRIVATE_URL).toBe('HAPPIER_URL');
    });

    it('keeps runtime operations explicit instead of overloading legacy managedServer', () => {
        expectTypeOf<LocalServicesRuntimeServiceV1['declare']>()
            .toEqualTypeOf<(declaration: LocalServiceDeclarationV1) => Promise<void>>();
    });
});
