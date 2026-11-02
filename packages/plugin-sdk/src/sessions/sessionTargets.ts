import {
    SessionTargetV1ProtocolSchema as canonicalTarget,
    ActionSessionAddressV1ProtocolSchema as canonicalAddress,
} from '@happier-dev/protocol/actions/sessionTargetV1';
import type { SessionTargetV1 } from '../actions/dtos/pluginActionDtoSupport.generated.js';
import type { ProtocolComposableSchema } from '../protocol/protocolFacade.js';

export type { SessionTargetV1, SessionTargetSelectorV1, ActionSessionTargetDeclarationV1 } from '../actions/dtos/pluginActionDtoSupport.generated.js';
export type { ActionResolvedSessionTargetsV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
/** An already resolved Home and Session, never an unresolved selector. */
export type ActionSessionAddressV1 = Readonly<{ serverId: string; sessionId: string }>;

/** Both values delegate to Protocol's incumbent input and exact-address owners. */
export const SessionTargetV1Schema: ProtocolComposableSchema<SessionTargetV1> = canonicalTarget;
export const ActionSessionAddressV1Schema: ProtocolComposableSchema<ActionSessionAddressV1> = canonicalAddress;
