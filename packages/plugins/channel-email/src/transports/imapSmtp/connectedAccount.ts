import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1, type ConnectedAccountAuthenticationContext,
  type ConnectedAccountAuthCompletionResult, type ConnectedAccountHealthResult,
  type ConnectedAccountManualCompletion, type ConnectedAccountReadContext,
  type ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { normalizeEmailAddress } from '../../email/address.js';
import { createImapSmtpTransport, type ImapSmtpAccount } from './client.js';
import { EmailCredentialError, requestMicrosoftAppOnlyToken } from './credentials.js';

export const IMAP_SMTP_CONNECTED_ACCOUNT_ID = 'email-imap-smtp';
export const IMAP_SMTP_CREDENTIAL_PURPOSE = 'email-mailbox';
export const IMAP_SMTP_ENVIRONMENT_KEY = 'HAPPIER_EMAIL_IMAP_SMTP_ACCOUNT';

type AuthenticationMode = 'password' | 'microsoft-app-only';
type AccountContext = Pick<ConnectedAccountReadContext, 'configuration' | 'services' | 'signal'>;

function accountConfiguration(context: AccountContext): Omit<ImapSmtpAccount, 'auth'> & { username: string } {
  const values = context.configuration.values;
  const mailbox = typeof values.mailbox === 'string' ? normalizeEmailAddress(values.mailbox) : null;
  const host = (key: string) => {
    const value = values[key];
    if (typeof value !== 'string' || !value.trim() || /[\s\x00-\x1f/\\]/.test(value)) throw new EmailCredentialError('invalidConfiguration');
    return value;
  };
  const port = (key: string, fallback: number) => {
    const value = values[key] ?? fallback;
    // TCP's actual unsigned 16-bit port boundary, not a Happier limit.
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) throw new EmailCredentialError('invalidConfiguration');
    return value;
  };
  const folder = (key: string, fallback?: string) => {
    const value = values[key] ?? fallback;
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)) throw new EmailCredentialError('invalidConfiguration');
    return value;
  };
  if (!mailbox) throw new EmailCredentialError('invalidConfiguration');
  if (values.smtpSecurity !== undefined && values.smtpSecurity !== 'tls' && values.smtpSecurity !== 'starttls') throw new EmailCredentialError('invalidConfiguration');
  if (values.tlsCaPem !== undefined && (typeof values.tlsCaPem !== 'string' || !values.tlsCaPem.trim())) throw new EmailCredentialError('invalidConfiguration');
  const username = typeof values.username === 'string' && values.username.trim() ? values.username.trim() : mailbox;
  return { mailbox, username, imapHost: host('imapHost'), imapPort: port('imapPort', 993),
    smtpHost: host('smtpHost'), smtpPort: port('smtpPort', 587), inboxFolder: folder('inboxFolder', 'INBOX')!,
    ...(folder('sentFolder') ? { sentFolder: folder('sentFolder') } : {}),
    ...(values.smtpSecurity ? { smtpSecurity: values.smtpSecurity } : {}),
    ...(typeof values.tlsCaPem === 'string' ? { tlsCaPem: values.tlsCaPem } : {}) };
}

async function authenticate(mode: AuthenticationMode, fields: Readonly<Record<string, string>>, context: AccountContext, signal: AbortSignal): Promise<ImapSmtpAccount> {
  const config = accountConfiguration(context);
  if (mode === 'password') {
    if (!fields.password) throw new EmailCredentialError('credentialInvalid');
    return { ...config, auth: { user: config.username, pass: fields.password } };
  }
  const accessToken = await requestMicrosoftAppOnlyToken({ tenantId: fields.tenantId ?? '', clientId: fields.clientId ?? '', clientSecret: fields.clientSecret ?? '' }, context.services.http, signal);
  return { ...config, auth: { user: config.mailbox, accessToken } };
}

function diagnostic(code: string) { return { code, severity: 'error' as const, message: 'The mailbox could not be authenticated. Check its settings and credentials.' }; }
function rejected(error: unknown): boolean {
  return error instanceof EmailCredentialError ? error.reason !== 'network'
    : Boolean(error && typeof error === 'object' && (
      ('authenticationFailed' in error && error.authenticationFailed === true)
      || ('code' in error && error.code === 'EAUTH')
      || ('responseCode' in error && typeof error.responseCode === 'number' && error.responseCode >= 500 && error.responseCode < 600)));
}

async function complete(mode: AuthenticationMode, input: ConnectedAccountManualCompletion, context: ConnectedAccountAuthenticationContext, options?: Readonly<{ signal?: AbortSignal }>): Promise<ConnectedAccountAuthCompletionResult> {
  const signal = options?.signal ?? context.signal;
  try {
    const account = await authenticate(mode, input.fields, context, signal);
    await createImapSmtpTransport(account).connectionTest(signal);
    signal.throwIfAborted();
    // Only a verified login reaches the host's attempt credential store.
    const keys = mode === 'password' ? ['password'] : ['tenantId', 'clientId', 'clientSecret'];
    for (const key of keys) await context.attemptCredentials.set(key, input.fields[key], { signal });
    await context.attemptCredentials.set('authenticationMode', mode, { signal });
    return { status: 'connected', accountId: account.mailbox, providerIdentity: { accountId: account.mailbox }, displayName: account.mailbox, scopes: [] };
  } catch (error) {
    signal.throwIfAborted();
    if (rejected(error)) return { status: 'rejected', diagnostic: diagnostic('email_mailbox_login_failed') };
    return { status: 'unavailable', diagnostic: diagnostic('email_mailbox_login_failed') };
  }
}

async function readAccount(context: ConnectedAccountReadContext, signal: AbortSignal): Promise<ImapSmtpAccount> {
  const mode = await context.credentials.get('authenticationMode', { signal });
  if (mode !== 'password' && mode !== 'microsoft-app-only') throw new EmailCredentialError('credentialInvalid');
  const keys = mode === 'password' ? ['password'] : ['tenantId', 'clientId', 'clientSecret'];
  const fields: Record<string, string> = {};
  for (const key of keys) fields[key] = await context.credentials.get(key, { signal }) ?? '';
  return authenticate(mode, fields, context, signal);
}

async function health(context: ConnectedAccountReadContext, options?: Readonly<{ signal?: AbortSignal }>): Promise<ConnectedAccountHealthResult> {
  const signal = options?.signal ?? context.signal;
  try {
    const account = await readAccount(context, signal);
    await createImapSmtpTransport(account).connectionTest(signal);
    return { status: 'connected', displayName: account.mailbox, scopes: [] };
  } catch (error) {
    signal.throwIfAborted();
    return { status: rejected(error) ? 'reconnectRequired' : 'unavailable', diagnostic: diagnostic('email_mailbox_login_failed') };
  }
}

export const imapSmtpConnectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: {
    password: { kind: 'manual', complete: (input, context, options) => complete('password', input, context, options) },
    'microsoft-app-only': { kind: 'manual', complete: (input, context, options) => complete('microsoft-app-only', input, context, options) },
  } },
  status: health, refresh: health,
  async revoke() { return { status: 'remoteUnsupported' }; },
  async materialize(request, context, options) {
    if (request.kind !== 'environment') throw new EmailCredentialError('invalidConfiguration');
    const env: Record<string, string> = {};
    if (request.keys.includes(IMAP_SMTP_ENVIRONMENT_KEY)) {
      const account = await readAccount(context, options?.signal ?? context.signal);
      // Application secrets remain in Connected Accounts; callers receive only the current bearer.
      env[IMAP_SMTP_ENVIRONMENT_KEY] = JSON.stringify(account);
    }
    return { kind: 'environment', env };
  },
};

const textField = (id: string, title: string, required = true) => ({ id, title, required, secret: false as const, schema: { type: 'string' as const, minLength: 1 } });
const configuration = {
  scope: 'account' as const, changeBehavior: 'reconnect' as const,
  fields: [textField('mailbox', 'Mailbox address'), { ...textField('username', 'Username', false), description: 'Defaults to the mailbox address.' },
    textField('imapHost', 'IMAP TLS host'), { id: 'imapPort', title: 'IMAP TLS port', secret: false as const, default: 993, schema: { type: 'integer' as const, minimum: 1, maximum: 65535 } },
    textField('smtpHost', 'SMTP submission host'), { id: 'smtpPort', title: 'SMTP submission port', secret: false as const, default: 587, schema: { type: 'integer' as const, minimum: 1, maximum: 65535 } },
    { id: 'smtpSecurity', title: 'SMTP security', description: 'Port 465 uses TLS; other ports use STARTTLS.', required: false, secret: false as const,
      schema: { type: 'string' as const, enum: ['starttls', 'tls'] },
      presentation: { control: 'select' as const, options: [{ value: 'starttls', title: 'STARTTLS' }, { value: 'tls', title: 'TLS' }] } },
    { ...textField('inboxFolder', 'Inbox folder', false), default: 'INBOX' }, { ...textField('sentFolder', 'Sent folder', false), description: 'Found automatically when left empty.' },
    { ...textField('tlsCaPem', 'Custom TLS CA certificate (PEM)', false),
      presentation: { control: 'textarea' as const },
      description: 'Trust this certificate authority for both IMAP and SMTP. Leave empty to use the standard trusted authorities.' }],
};

export const imapSmtpConnectedAccountDescriptor = {
  declaration: { title: 'Email IMAP + SMTP', description: 'Mailbox credentials for secure IMAP receiving and SMTP submission.',
    authentication: { defaultModeId: 'password', modes: [
      { id: 'password', title: 'App password', kind: 'manual' as const, outcomeReconciliation: 'none' as const,
        setup: {
          url: 'https://support.mozilla.org/en-US/kb/manual-account-configuration',
          checklist: ['Check your mail provider instructions for IMAP and SMTP access and the required server settings.', 'If your provider requires an app password, create one in that provider account; otherwise use the mailbox password it supports.', 'Enter that password and the matching mailbox and server settings here.'],
          createKeyTitle: 'Read manual mailbox setup guidance',
        },
        directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 }, configuration,
        fields: [{ id: 'password', title: 'Password or app password', secret: true, schema: { type: 'string' as const, minLength: 1 } }] },
      { id: 'microsoft-app-only', title: 'Microsoft app-only', kind: 'manual' as const, outcomeReconciliation: 'none' as const,
        setup: {
          url: 'https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth/',
          checklist: ['Register an application in Microsoft Entra and create a client secret.', 'Grant the Exchange Online application permissions IMAP.AccessAsApp and SMTP.SendAsApp, obtain admin consent, and register its service principal in Exchange.', 'Grant access to the mailbox, then enter the tenant ID, application client ID, client secret, and mailbox server settings here.'],
          createKeyTitle: 'Read Microsoft mailbox application setup',
        },
        directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 }, configuration,
        fields: [{ id: 'tenantId', title: 'Entra tenant ID or domain', secret: false, schema: { type: 'string' as const, minLength: 1 } },
          { id: 'clientId', title: 'Application client ID', secret: false, schema: { type: 'string' as const, minLength: 1 } },
          { id: 'clientSecret', title: 'Application client secret', secret: true, schema: { type: 'string' as const, minLength: 1 } }] },
    ] } }, runtime: imapSmtpConnectedAccountRuntime,
};
