import { defineServerConfigRegistry } from '@happier-dev/protocol/serverConfig/serverConfigEntry';

const restartBillingSetting = {
    apply: 'restart', editable: 'home', section: 'server', group: 'billing',
} as const;

export const BILLING_SERVER_CONFIG = defineServerConfigRegistry({
    REVENUECAT_WEBHOOK_AUTH: {
        ...restartBillingSetting, type: 'string', sensitivity: 'secret',
        description: 'Authorization header configured for incoming RevenueCat webhooks.',
    },
    POLAR_ACCESS_TOKEN: {
        ...restartBillingSetting, type: 'string', sensitivity: 'secret',
        description: 'Polar organization access token for reconciling purchases.',
    },
    POLAR_WEBHOOK_SECRET: {
        ...restartBillingSetting, type: 'string', sensitivity: 'secret',
        description: 'Signing secret for incoming Polar webhooks.',
    },
    POLAR_SERVER: {
        ...restartBillingSetting, type: 'enum', default: 'production', sensitivity: 'plain',
        bounds: { values: ['production', 'sandbox'] },
        description: 'Polar environment to use for billing.',
    },
});
