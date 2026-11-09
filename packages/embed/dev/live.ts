import { connect, type HappierClient, type HappierSessionController } from '@happier-dev/sdk';
import { readTypedErrorCode, runDeniedModelProbe } from './liveProbe';

type LiveBootstrap = Readonly<{ endpoint: string; sessionId: string; token: string }>;

const leadId = decodeURIComponent(location.pathname.split('/').filter(Boolean).at(-1) ?? '');
const status = element('connection-state');
const transport = element('transport');
const transcript = element('transcript');
const pending = element('pending');
const polling = input('polling-mode');
const otherSession = input('other-session-id');
otherSession.value = new URL(location.href).searchParams.get('otherSessionId') ?? '';

let client: HappierClient | undefined;
let controller: HappierSessionController | undefined;
let unsubscribe: (() => void) | undefined;

function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing fixture element ${id}`);
  return value;
}

function input(id: string): HTMLInputElement {
  const value = element(id);
  if (!(value instanceof HTMLInputElement)) throw new Error(`Fixture element ${id} is not an input`);
  return value;
}

function messageText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.kind === 'string') return record.kind;
  return '';
}

function render() {
  if (!controller) return;
  const snapshot = controller.getSnapshot();
  status.textContent = snapshot.connection;
  transport.textContent = controller.transport === 'action' ? 'polling' : controller.transport;
  transcript.replaceChildren(...snapshot.transcript.messageIdsOldestFirst.map((id) => {
    const item = document.createElement('li');
    item.dataset.messageId = id;
    item.textContent = messageText(snapshot.transcript.messagesById[id]);
    return item;
  }));
  const permissions = snapshot.pendingRequests.filter((request) => request.kind === 'permission');
  pending.textContent = permissions.length ? `${permissions.length} permission pending` : 'No permission pending';
  (element('approve-permission') as HTMLButtonElement).disabled = permissions.length === 0;
}

async function closeLive() {
  unsubscribe?.();
  unsubscribe = undefined;
  const activeController = controller;
  const activeClient = client;
  controller = undefined;
  client = undefined;
  if (activeController) await activeController.close();
  if (activeClient) await activeClient.close();
}

async function bootstrap(): Promise<LiveBootstrap> {
  const response = await fetch(`/api/live/${encodeURIComponent(leadId)}/credential`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    const code = value && typeof value === 'object' && typeof (value as { error?: unknown }).error === 'string'
      ? (value as { error: string }).error : `http_${response.status}`;
    throw Object.assign(new Error(code), { code });
  }
  return await response.json() as LiveBootstrap;
}

async function connectLive() {
  status.textContent = 'connecting';
  await closeLive();
  const credential = await bootstrap();
  const nextClient = connect({ endpoint: credential.endpoint, token: credential.token });
  try {
    const nextController = await nextClient.sessions.get(credential.sessionId).live({
      transport: polling.checked ? 'action' : 'auto',
    });
    client = nextClient;
    controller = nextController;
    unsubscribe = nextController.subscribe(render);
    render();
  } catch (error) {
    await nextClient.close();
    throw error;
  }
}

function action(id: string, run: () => Promise<void>) {
  const button = element(id) as HTMLButtonElement;
  button.addEventListener('click', () => {
    button.disabled = true;
    void run().catch((error: unknown) => { status.textContent = readTypedErrorCode(error); }).finally(() => {
      if (id !== 'approve-permission') button.disabled = false;
      render();
    });
  });
}

action('reconnect', connectLive);
polling.addEventListener('change', () => { void connectLive().catch((error: unknown) => { status.textContent = readTypedErrorCode(error); }); });
action('send', async () => {
  const message = input('message');
  if (!controller || !message.value.trim()) return;
  await controller.send(message.value.trim());
  message.value = '';
});
action('approve-permission', async () => {
  const request = controller?.getSnapshot().pendingRequests.find((candidate) => candidate.kind === 'permission');
  if (!controller || !request) return;
  await controller.respondToPermission({ id: request.id, ...(request.turnId ? { turnId: request.turnId } : {}), approved: true });
});
action('negative-model', async () => {
  if (!client || !controller) return;
  const output = element('negative-model-code');
  output.textContent = await runDeniedModelProbe(client, controller.sessionId);
});
action('negative-session', async () => {
  if (!client || !otherSession.value.trim()) return;
  const output = element('negative-session-code');
  try {
    const other = await client.sessions.get(otherSession.value.trim()).live({ transport: 'action' });
    await other.close();
    output.textContent = 'unexpected_success';
  } catch (error) {
    output.textContent = readTypedErrorCode(error);
  }
});
action('negative-token', async () => {
  if (!client) return;
  const output = element('negative-token-code');
  try {
    const self = await client.apiTokens.self();
    const parentExpiry = self.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(self.expiresAt);
    const expiresAt = new Date(Math.min(Date.now() + 60_000, parentExpiry)).toISOString();
    const created = await client.apiTokens.createChild({ label: 'Fixture refusal probe', expiresAt, grant: self.grant });
    await client.apiTokens.revokeChild(created.apiToken.tokenId);
    output.textContent = 'unexpected_success';
  } catch (error) {
    output.textContent = readTypedErrorCode(error);
  }
});

window.addEventListener('pagehide', () => { void closeLive(); }, { once: true });
void connectLive().catch((error: unknown) => { status.textContent = readTypedErrorCode(error); });
