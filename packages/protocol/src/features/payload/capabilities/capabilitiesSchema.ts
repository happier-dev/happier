import { z } from 'zod';

import { OAuthProviderStatusSchema } from '../oauthProviderStatus.js';
import {
  BugReportsCapabilitiesSchema,
  DEFAULT_BUG_REPORTS_CAPABILITIES,
} from './bugReportsCapabilities.js';
import { DEFAULT_VOICE_CAPABILITIES, VoiceCapabilitiesSchema } from './voiceCapabilities.js';
import {
  DEFAULT_SOCIAL_FRIENDS_CAPABILITIES,
  SocialFriendsCapabilitiesSchema,
} from './socialFriendsCapabilities.js';
import {
  AuthCapabilitiesSchema,
  DEFAULT_AUTH_CAPABILITIES,
} from './authCapabilities.js';
import {
  DEFAULT_ENCRYPTION_CAPABILITIES,
  EncryptionCapabilitiesSchema,
} from './encryptionCapabilities.js';
import {
  DEFAULT_MACHINE_TRANSFER_CAPABILITIES,
  MachineTransferCapabilitiesSchema,
} from './machineTransferCapabilities.js';
import {
  DEFAULT_SERVER_CAPABILITIES,
  ServerCapabilitiesSchema,
} from './serverCapabilities.js';

export const CapabilitiesSchema = z.object({
  bugReports: BugReportsCapabilitiesSchema.optional().default(DEFAULT_BUG_REPORTS_CAPABILITIES),
  voice: VoiceCapabilitiesSchema.optional().default(DEFAULT_VOICE_CAPABILITIES),
  encryption: EncryptionCapabilitiesSchema.optional().default(DEFAULT_ENCRYPTION_CAPABILITIES),
  server: ServerCapabilitiesSchema.optional().default(DEFAULT_SERVER_CAPABILITIES),
  machines: z
    .object({
      transfer: MachineTransferCapabilitiesSchema.optional().default(DEFAULT_MACHINE_TRANSFER_CAPABILITIES),
    })
    .optional()
    .default({ transfer: DEFAULT_MACHINE_TRANSFER_CAPABILITIES }),
  social: z
    .object({
      friends: SocialFriendsCapabilitiesSchema.optional().default(DEFAULT_SOCIAL_FRIENDS_CAPABILITIES),
    })
    .optional()
    .default({ friends: DEFAULT_SOCIAL_FRIENDS_CAPABILITIES }),
  oauth: z
    .object({
      providers: z.record(z.string(), OAuthProviderStatusSchema),
    })
    .optional()
    .default({ providers: {} }),
  auth: AuthCapabilitiesSchema.optional().default(DEFAULT_AUTH_CAPABILITIES),
});

export type Capabilities = z.infer<typeof CapabilitiesSchema>;
