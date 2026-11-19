import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { MarkdownInlineReferences } from '@/components/markdown/markdownInlineReferences';
import { referenceChipFill } from '@/components/ui/referenceChip/referenceChipFill';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useSessionTranscriptSource } from '../source/SessionTranscriptSourceContext';
import { resolveInlineMessageReference, type MessageStructuredReferences } from './messageStructuredReferences';
import { useTranscriptSessionReferenceIdentities } from './useTranscriptSessionIdentity';

/** How long a picture keeps the ring its "Image #N" chip put on it. */
const IMAGE_RING_MS = 1600;

export type MessageInlinePictures = Readonly<{
  /** "Image #N" by picture path, for the numbered thumbnails above the text. */
  numbers: ReadonlyMap<string, number>;
  /** The picture an "Image #N" chip was just pressed for. */
  ringedPath: string | null;
  /** A loaded picture reports its preview, so its chip can show it. */
  onPreviewLoaded: (path: string, uri: string) => void;
}>;

/**
 * The bubble's inline chips (D5, lab T1): each bound `happier-ref` token resolves to the shared chip,
 * in the bubble's own ink. Pressing a Session opens it, a file opens in the workspace, and an
 * "Image #N" chip rings its numbered picture above the text. Unbound tokens stay their labels.
 * A Session chip names its target as it is now: the live title and the Agent's mark, read through one
 * subscription to only this message's targets; a deleted target dims and stops opening.
 */
export function useMessageInlineReferences(
  input: Readonly<{
    projection: MessageStructuredReferences;
    pictures: ReadonlyArray<Readonly<{ path: string; numberKey: string }>>;
    serverId?: string | null;
    openPath: (path: string) => boolean;
    /** The prose the chips sit in; a chip takes that ink (default: the user bubble's). */
    surface?: 'user' | 'agent';
  }>,
): Readonly<{
  inlineReferences: MarkdownInlineReferences | undefined;
  pictures: MessageInlinePictures;
}> {
  const { theme } = useUnistyles();
  const transcriptSource = useSessionTranscriptSource();
  const [ringedPath, setRingedPath] = React.useState<string | null>(null);
  const [previews, setPreviews] = React.useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const { inline, imageNumbers } = input.projection;
  const sessionIds = React.useMemo(
    () => [...inline.values()].flatMap((reference) => reference.sessionId ? [reference.sessionId] : []),
    [inline],
  );
  const sessionIdentities = useTranscriptSessionReferenceIdentities(sessionIds, input.serverId);
  const identityBySessionId = React.useMemo(
    () => new Map(sessionIds.map((sessionId, index) => [sessionId, sessionIdentities[index]])),
    [sessionIdentities, sessionIds],
  );

  const numbers = React.useMemo(() => {
    const byPath = new Map<string, number>();
    for (const picture of input.pictures) {
      const number = imageNumbers.get(picture.numberKey);
      if (number !== undefined) byPath.set(picture.path, number);
    }
    return byPath;
  }, [imageNumbers, input.pictures]);
  const pathByNumber = React.useMemo(
    () => new Map([...numbers].map(([path, number]) => [number, path])),
    [numbers],
  );

  React.useEffect(() => {
    if (ringedPath === null) return undefined;
    const timer = setTimeout(() => setRingedPath(null), IMAGE_RING_MS);
    return () => clearTimeout(timer);
  }, [ringedPath]);

  const onPreviewLoaded = React.useCallback((path: string, uri: string) => {
    setPreviews((current) =>
      current.get(path) === uri ? current : new Map(current).set(path, uri),
    );
  }, []);

  const ink = input.surface === 'agent' ? theme.colors.text.primary : theme.colors.message.user.foreground;
  const goneInk = theme.colors.text.tertiary;
  const navigate = transcriptSource.navigate;
  const { openPath, serverId } = input;
  const inlineReferences = React.useMemo<
    MarkdownInlineReferences | undefined
  >(() => {
    if (inline.size === 0) return undefined;
    const background = referenceChipFill(ink);
    return {
      resolve: (ref: string, sourceToken?: string) => {
        const reference = resolveInlineMessageReference(inline, ref, sourceToken);
        if (!reference) return null;
        const picturePath =
          reference.imageNumber !== undefined
            ? pathByNumber.get(reference.imageNumber)
            : undefined;
        const preview = picturePath ? previews.get(picturePath) : undefined;
        const session = reference.sessionId ? identityBySessionId.get(reference.sessionId) : undefined;
        const agentId = session?.agentId ?? reference.agentId;
        return {
          label: session?.title ?? reference.label,
          foreground: session?.deleted ? goneInk : ink,
          background,
          glyph: reference.glyph,
          ...(agentId ? { agentId } : {}),
          ...(preview ? { thumbnail: { uri: preview } } : {}),
        };
      },
      onPress: (ref) => {
        const reference = inline.get(ref);
        if (!reference) return;
        if (reference.imageNumber !== undefined) {
          const path = pathByNumber.get(reference.imageNumber);
          if (path) setRingedPath(path);
          return;
        }
        if (reference.sessionId && identityBySessionId.get(reference.sessionId)?.deleted) return;
        if (reference.sessionId && navigate) {
          navigate(
            buildScopedSessionRouteHref({
              sessionId: reference.sessionId,
              serverId,
            }),
          );
          return;
        }
        if (reference.path) openPath(reference.path);
      },
    };
  }, [goneInk, identityBySessionId, ink, inline, navigate, openPath, pathByNumber, previews, serverId]);

  const pictures = React.useMemo<MessageInlinePictures>(
    () => ({ numbers, ringedPath, onPreviewLoaded }),
    [numbers, onPreviewLoaded, ringedPath],
  );
  return { inlineReferences, pictures };
}
