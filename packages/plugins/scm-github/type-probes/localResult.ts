import type { JsonValue, ProtocolActionSchemaInput, ProtocolActionSchemaOutput } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { ProtocolComposableSchema } from '@happier-dev/plugin-sdk/protocol';
import { GITHUB_LOCAL_ACT_ACTIONS_V1 } from '../src/actions/local/contribution.js';

const action = GITHUB_LOCAL_ACT_ACTIONS_V1['github/actions/local-run'];
const schema: ProtocolComposableSchema<unknown, JsonValue> = action.resultSchema;
const handler: ActionHandler<ProtocolActionSchemaInput<typeof action.inputSchema>, ProtocolActionSchemaOutput<typeof action.resultSchema>> = action.run;
void schema;
void handler;
