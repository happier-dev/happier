import { defineServerConfigRegistry } from '@happier-dev/protocol';

export const USAGE_PRICE_SERVER_CONFIG = defineServerConfigRegistry({
    HAPPIER_USAGE_MODEL_PRICE_FETCH_ENABLED: {
        type: 'boolean', default: true, sensitivity: 'plain', apply: 'live', editable: 'home',
        section: 'data', family: 'usage',
        description: 'Allows explicit Usage model-price refresh from the public LiteLLM catalog. Off uses bundled prices; the cached catalog is retained for re-enable.',
    },
});
