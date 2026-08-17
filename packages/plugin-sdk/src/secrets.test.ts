import { describe, expect, it } from 'vitest';
import { SecretStringV1Schema as ProtocolSecretStringV1Schema } from '@happier-dev/protocol/runtime';

import * as secrets from './secrets.js';

describe('Secrets public projection', () => {
    it('owns the canonical SecretString schema projection', () => {
        expect(secrets.SecretStringV1Schema).toBe(ProtocolSecretStringV1Schema);
    });
});
