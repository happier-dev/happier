import { describe, expect, it } from 'vitest';

import { redactSentryPublicShareTelemetry } from './sentryPublicShareRedaction';

describe('sentry public-share telemetry redaction', () => {
    it('templates public bearer capabilities across event, transaction, log, and breadcrumb fields', () => {
        const capability = 'SENTINEL_PUBLIC_SHARE_CAPABILITY';
        const redacted = redactSentryPublicShareTelemetry({
            transaction: `GET /share/${capability}`,
            request: {
                url: `https://app.example.test/share/${capability}`,
            },
            message: new String(`failed /share/${capability}`),
            breadcrumbs: [{
                data: {
                    url: `/share/${capability}`,
                },
            }],
        });

        expect(JSON.stringify(redacted)).not.toContain(capability);
        expect(redacted.request.url).toContain('/share/:token');
    });
});
