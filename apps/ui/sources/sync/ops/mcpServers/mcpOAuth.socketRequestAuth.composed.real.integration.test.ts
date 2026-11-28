import { afterEach, beforeEach, it } from 'vitest';
import '../../../../../cli/src/vitestSetup.composed.testkit';

import {
    exerciseMcpOAuthMachineTest,
    exerciseMcpOAuthSocketRequestAuth,
    prepareMcpOAuthSocketRequestAuthFixture,
    closeMcpOAuthSocketRequestAuthFixture,
} from '../../../../../cli/src/mcp/oauth/mcpOAuthSocketRequestAuth.testkit.mjs';

beforeEach(() => prepareMcpOAuthSocketRequestAuthFixture({ encryptionMode: 'e2ee' }));
afterEach(closeMcpOAuthSocketRequestAuthFixture);

it('composes E2EE CLI sign-in and reconnect, registered OAuth Test persistence and consecutive Session tool calls',
    exerciseMcpOAuthMachineTest);

it('settles a supplied OAuth app through the registered daemon and durable Account owners', async () => {
    await exerciseMcpOAuthSocketRequestAuth({ ownClient: true });
});
