import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { discussionFailureLabel } from './discussionFailureLabel';

describe('discussionFailureLabel', () => {
    it.each(['doc_passage_mismatch', 'server_target_mismatch', 'invalid_parameters', 'discussion_invalid_reply_target'])(
        'retains the closed send refusal %s instead of hiding it behind the generic failure', code => {
            expect(discussionFailureLabel(code)).toContain(code);
        },
    );

    it.each([undefined, 'private payload /home/person/secret'])('never displays an unrecognized diagnostic as a reason (%s)', code => {
        expect(discussionFailureLabel(code)).toBe(t('session.collaboration.discussion.sendFailed'));
    });
});
