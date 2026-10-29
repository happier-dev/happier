import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createDeferred, createSessionFixture } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { storage } from '@/sync/domains/state/storage';
import { setActiveServerId, setServerProfileIdentityForUrl, upsertServerProfile, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { sessionDelete, sessionDeleteWithServerScope } from '../../ops';

const sessionId = 'same_session_id';
const successResponse = () => new Response(JSON.stringify({ success: true }));

describe('sessionDeleteWithServerScope', () => {
  let serverA: ServerProfile;
  let serverB: ServerProfile;
  let activeRequest: MockInstance<typeof apiSocket.request>;
  const activeResponse = vi.fn(async () => successResponse());
  const remoteRequest = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => successResponse());

  function requestAtTransportBoundary(path: string, init?: RequestInit): Promise<Response>;
  function requestAtTransportBoundary<T>(path: string, init: RequestInit | undefined, consume: (response: Response) => Promise<T>): Promise<T>;
  async function requestAtTransportBoundary<T>(_path: string, _init?: RequestInit, consume?: (response: Response) => Promise<T>): Promise<Response | T> {
    const response = await activeResponse();
    return consume ? await consume(response) : response;
  }

  function seedRemoteSession(serverId: string) {
    const renderable = buildSessionListRenderableFromSession(createSessionFixture({ id: sessionId, archivedAt: 42 }));
    storage.setState((state) => ({
      sessionListViewDataByServerId: {
        ...state.sessionListViewDataByServerId,
        [serverId]: [{ type: 'session', session: renderable, serverId }],
      },
    }));
  }

  beforeEach(() => {
    storage.setState(storage.getInitialState(), true);
    serverA = upsertServerProfile({ serverUrl: 'https://delete-a.example' });
    serverB = upsertServerProfile({ serverUrl: 'https://delete-b.example' });
    setActiveServerId(serverA.id);
    activeResponse.mockReset();
    activeResponse.mockImplementation(async () => successResponse());
    activeRequest = vi.spyOn(apiSocket, 'request').mockImplementation(requestAtTransportBoundary);
    // Credentials and network transport are external boundaries; resolution and deletion stay real.
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
      token: 'header.eyJzdWIiOiJhY2NvdW50LWIifQ.signature',
    });
    remoteRequest.mockReset();
    remoteRequest.mockImplementation(async () => successResponse());
    setRuntimeFetch(remoteRequest);
    storage.getState().applySessions([createSessionFixture({ id: sessionId, serverId: serverA.id, archivedAt: 42 })]);
  });

  afterEach(() => {
    resetRuntimeFetch();
    vi.restoreAllMocks();
  });

  it('deletes the active session and its list projection after server success', async () => {
    await expect(sessionDeleteWithServerScope(sessionId, { serverId: serverA.id })).resolves.toEqual({ success: true });

    expect(activeRequest).not.toHaveBeenCalled();
    expect(remoteRequest.mock.calls.some(([url, init]) => String(url).includes(`/v1/sessions/${sessionId}`) && init?.method === 'DELETE')).toBe(true);
    expect(storage.getState().sessions[sessionId]).toBeUndefined();
    expect(storage.getState().sessionListRenderables[sessionId]).toBeUndefined();
    expect(storage.getState().sessionListViewDataByServerId[serverA.id]?.some((item) => item.type === 'session' && item.session.id === sessionId)).toBe(false);
  });

  it('removes a remote Home row through an identity alias while retaining a same-id active session', async () => {
    seedRemoteSession(serverB.id);
    setServerProfileIdentityForUrl(serverB.serverUrl, 'srv_delete_b');
    const activeSession = storage.getState().sessions[sessionId];
    const activeRows = storage.getState().sessionListViewDataByServerId[serverA.id];

    await expect(sessionDeleteWithServerScope(sessionId, { serverId: serverB.id })).resolves.toEqual({ success: true });

    expect(storage.getState().sessions[sessionId]).toBe(activeSession);
    expect(storage.getState().sessionListViewDataByServerId[serverA.id]).toBe(activeRows);
    expect(storage.getState().sessionListViewDataByServerId.srv_delete_b).toEqual([]);
    expect(activeRequest).not.toHaveBeenCalled();
    const deleteCall = remoteRequest.mock.calls.find(([url, init]) => String(url).includes(`/v1/sessions/${sessionId}`) && init?.method === 'DELETE');
    expect(deleteCall).toBeDefined();
    expect(new Headers(deleteCall?.[1]?.headers).get('Authorization')).toBe('Bearer header.eyJzdWIiOiJhY2NvdW50LWIifQ.signature');
  });

  it.each(['active', 'scoped'] as const)('retains local state when the %s Home rejects deletion', async (scope) => {
    seedRemoteSession(serverB.id);
    const targetServerId = scope === 'active' ? serverA.id : serverB.id;
    const response = () => new Response('denied', { status: 403 });
    remoteRequest.mockImplementation(async () => response());
    const before = storage.getState();

    await expect(sessionDeleteWithServerScope(sessionId, { serverId: targetServerId })).resolves.toMatchObject({ success: false });

    expect(storage.getState().sessions).toBe(before.sessions);
    expect(storage.getState().sessionListViewDataByServerId).toBe(before.sessionListViewDataByServerId);
  });

  it('settles against the original Home when the active Home changes during the request', async () => {
    const response = createDeferred<Response>();
    remoteRequest.mockImplementation(async () => response.promise);
    const run = sessionDeleteWithServerScope(sessionId);
    await vi.waitFor(() => expect(remoteRequest).toHaveBeenCalled());
    setActiveServerId(serverB.id);
    const replacement = createSessionFixture({ id: sessionId, serverId: serverB.id });
    storage.setState({ sessions: { [sessionId]: replacement } });
    response.resolve(successResponse());

    await expect(run).resolves.toEqual({ success: true });
    expect(storage.getState().sessions[sessionId]).toBe(replacement);
    expect(storage.getState().sessionListViewDataByServerId[serverA.id]?.some((item) => item.type === 'session' && item.session.id === sessionId)).toBe(false);
  });

  it('sessionDelete resolves the session owner Home from local state', async () => {
    storage.setState({ sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId: serverB.id }) } });
    seedRemoteSession(serverB.id);

    await expect(sessionDelete(sessionId)).resolves.toEqual({ success: true });

    expect(remoteRequest.mock.calls.some(([url, init]) => String(url).includes(`/v1/sessions/${sessionId}`) && init?.method === 'DELETE')).toBe(true);
    expect(activeRequest).not.toHaveBeenCalled();
  });
});
