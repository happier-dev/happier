import {
  createContext,
  useContext,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { useOptionalHappierTabPanelActivityInternal } from '../presentation/navigation/Tabs.js';
import {
  createSessionPartClaims,
  useSessionPartClaim,
  type SessionPartClaims,
  type SessionPartKind,
} from '../presentationHost/sessionPartClaims.js';

export type SessionProviderProps = Readonly<{
  /** A Session in the mounting surface's Account. The host resolves it; nothing else is trusted. */
  sessionId: string;
  /** Narrow to a live read-only view: no composer, prompts not actionable here. Default false. */
  readOnly?: boolean;
  children: ReactNode;
  /** Rendered instead of `children` when this host cannot present a Session. */
  fallback?: ReactNode;
}>;

export type SessionPartProps = Readonly<{ testID?: string }>;

export type SessionChatProps = Readonly<{
  sessionId: string;
  /** 'chat' (default) = provider + transcript + composer; 'transcript' = read-only provider + transcript. */
  variant?: 'chat' | 'transcript';
  fallback?: ReactNode;
  testID?: string;
}>;

const SessionPartClaimsContext = createContext<SessionPartClaims | null>(null);
const TRANSCRIPT_PART = ['transcript'] as const;
const COMPOSER_PART = ['composer'] as const;

function normalizeSessionId(sessionId: string): string {
  return typeof sessionId === 'string' ? sessionId.trim() : '';
}

/**
 * The one host controller for one Session. Arrange `SessionTranscript` and `SessionComposer` inside
 * it however the surface needs; they are views of this controller, never separate bindings.
 */
export function SessionProvider(props: SessionProviderProps): ReactElement | null {
  const tabActivity = useOptionalHappierTabPanelActivityInternal();
  const host = useOptionalPluginUiPresentationHost();
  const renderSessionPart = host?.renderSessionPart;
  const [claims] = useState(createSessionPartClaims);
  const sessionId = normalizeSessionId(props.sessionId);
  if (!renderSessionPart || sessionId.length === 0) return <>{props.fallback ?? null}</>;
  return (
    <>
      {renderSessionPart(Object.freeze({
        part: 'provider',
        sessionId,
        readOnly: props.readOnly === true,
        ...(tabActivity ? { presented: tabActivity.active } : {}),
        children: (
          <SessionPartClaimsContext.Provider value={claims}>
            {props.children}
          </SessionPartClaimsContext.Provider>
        ),
      }))}
    </>
  );
}

function SessionPart(props: SessionPartProps & Readonly<{ part: SessionPartKind }>): ReactElement | null {
  const host = useOptionalPluginUiPresentationHost();
  const claims = useContext(SessionPartClaimsContext);
  const owns = useSessionPartClaim(claims, props.part === 'transcript' ? TRANSCRIPT_PART : COMPOSER_PART);
  const renderSessionPart = host?.renderSessionPart;
  if (!renderSessionPart || !owns) return null;
  return (
    <>
      {renderSessionPart(Object.freeze({
        part: props.part,
        ...(props.testID === undefined ? {} : { testID: props.testID }),
      }))}
    </>
  );
}

/** Live transcript with its prompts; fills the remaining height of its bounded flex column. */
export function SessionTranscript(props: SessionPartProps): ReactElement | null {
  return <SessionPart part="transcript" {...props} />;
}

/** The Session's composer at its natural height; renders nothing only for a read-only provider. */
export function SessionComposer(props: SessionPartProps): ReactElement | null {
  return <SessionPart part="composer" {...props} />;
}

/**
 * A live Session in the host's standard layout: transcript, prompts and composer exactly as the full
 * Session view draws them. `variant="transcript"` is the read-only view. It fills a bounded region.
 */
export function SessionChat(props: SessionChatProps): ReactElement | null {
  const tabActivity = useOptionalHappierTabPanelActivityInternal();
  const host = useOptionalPluginUiPresentationHost();
  const renderSessionPart = host?.renderSessionPart;
  const sessionId = normalizeSessionId(props.sessionId);
  if (!renderSessionPart || sessionId.length === 0) return <>{props.fallback ?? null}</>;
  return (
    <>
      {renderSessionPart(Object.freeze({
        part: 'chat',
        sessionId,
        readOnly: props.variant === 'transcript',
        ...(tabActivity ? { presented: tabActivity.active } : {}),
        ...(props.testID === undefined ? {} : { testID: props.testID }),
      }))}
    </>
  );
}
