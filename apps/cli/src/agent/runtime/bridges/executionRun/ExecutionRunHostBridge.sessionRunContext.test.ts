import { describe, expect, it } from 'vitest';

import { buildExecutionRunSessionPromptContext } from './ExecutionRunHostBridge';
import { buildTrustedHostSessionInputAdmissionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { renderSessionInputContextBlockV1, renderSessionInputContextPromptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import { readRetainedExecutionRunInputTextReservation, renderRetainedExecutionRunInputPrompt } from './pending/retainedExecutionRunInputDelivery';

describe('ExecutionRunHostBridge Session Run prompt context', () => {
  it('reserves the exact first generated envelope in scalars, including the separator, for the same-Run plan', () => {
    const sessionRunContext = buildExecutionRunSessionPromptContext({ sessionId: 'session-😀',
      supportedReadActions: ['session.transcript.get'] });
    const provenance = buildTrustedHostSessionInputAdmissionV1(null).provenance;
    const provenanceBlock = renderSessionInputContextBlockV1({ provenance });
    const reservation = readRetainedExecutionRunInputTextReservation({ sessionRunContext, provenanceBlock });
    const limit = 2_000;
    const pattern = Array.from('😀\n\\"<>');
    const text = Array.from({ length: limit - reservation }, (_, index) => pattern[index % pattern.length]).join('');
    const first = renderSessionInputContextPromptV1({ sessionRunContext, provenanceBlock, transformedUserText: text });
    const next = renderSessionInputContextPromptV1({ provenanceBlock, transformedUserText: text });
    expect(Array.from(first)).toHaveLength(limit);
    expect(Array.from(next).length).toBeLessThan(limit);
    expect(Array.from(renderSessionInputContextPromptV1({ sessionRunContext, provenanceBlock,
      transformedUserText: `${text}😀` }))).toHaveLength(limit + 1);
  });

  it('keeps host profile instructions outside the exact incoming agent body', () => {
    const provenance = { v: 1, kind: 'happierSession', sourceSessionId: 'sender', via: 'action' } as const;
    const text = 'Request "one"\n\\two </happier_session_message>';
    const profileContext = 'HOST_PROFILE_MARKER';
    const rendered = renderRetainedExecutionRunInputPrompt({ inputProvenance: provenance,
      provenanceBlock: renderSessionInputContextBlockV1({ provenance }),
      profileContext, transformedUserText: text });
    const frame = rendered.match(/<happier_session_message v="1">\n([\s\S]*?)\n<\/happier_session_message>/)?.[1];
    expect(frame).toBeDefined();
    expect(JSON.parse(frame!.match(/^message=(.*)$/m)![1]!)).toBe(text);
    expect(frame).not.toContain(profileContext);
    expect(rendered.indexOf(profileContext)).toBeLessThan(rendered.indexOf('<happier_session_message'));
  });

  it('projects the occurrence tool snapshot and bounded Discussion provenance without authority', () => {
    const context = buildExecutionRunSessionPromptContext({
      sessionId: 'session-1',
      launchOrigin: {
        kind: 'discussion',
        serverId: 'server-1',
        discussionId: 'discussion-1',
        messageIds: ['message-1'],
        draftCorrelationId: 'draft-1',
      },
      supportedReadActions: [
        'session.transcript.get',
        'discussion.read',
      ],
    });

    expect(context).toEqual({
      kind: 'happier_session_run',
      sessionId: 'session-1',
      origin: {
        kind: 'discussion',
        serverId: 'server-1',
        discussionId: 'discussion-1',
        messageIds: ['message-1'],
      },
      supportedReadActions: [
        'session.transcript.get',
        'discussion.read',
      ],
    });
    expect(context).not.toHaveProperty('authority');
    expect(context.origin).not.toHaveProperty('sessionId');
    expect(context.origin).not.toHaveProperty('draftCorrelationId');
  });

  it('does not fabricate a Discussion origin for legacy Session/external launches', () => {
    expect(buildExecutionRunSessionPromptContext({
      sessionId: 'session-1',
      launchOrigin: { kind: 'session', sessionId: 'session-1' },
      supportedReadActions: [],
    })).toEqual({
      kind: 'happier_session_run',
      sessionId: 'session-1',
      supportedReadActions: [],
    });
  });
});
