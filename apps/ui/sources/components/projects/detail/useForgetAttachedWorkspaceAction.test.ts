import { describe, expect, it } from 'vitest';

import type { IModal } from '@/modal';
import { t } from '@/text';

import { confirmForgetAttachedWorkspace } from './useForgetAttachedWorkspaceAction';

describe('Forget confirmation for an attached workspace (lab project-forget)', () => {
  it('names each Project and says the remote workspace and its files stay (QA cut 34: the body was blank)', async () => {
    const shown: Array<{
      title: string;
      paragraphs: Array<string | undefined>;
      confirmText?: string;
    }> = [];
    const modal: Pick<IModal, 'confirm'> = {
      confirm: async (title, _message, options) => {
        // What the dialog draws: each paragraph's text, as WebAlertModal renders it.
        shown.push({
          title,
          paragraphs: (options?.messageParagraphs ?? []).map(
            (paragraph) => paragraph.text,
          ),
          confirmText: options?.confirmText,
        });
        return false;
      },
    };

    await expect(
      confirmForgetAttachedWorkspace('api-dev', ['api', 'web'], modal),
    ).resolves.toBe(false);

    expect(shown).toEqual([
      {
        title: t('projects.checkouts.forgetTitle', { workspace: 'api-dev' }),
        paragraphs: [
          `${t('projects.checkouts.forgetProjects', { projects: 'api, web', count: 2 })} ${t('projects.checkouts.forgetStays')}`,
          t('projects.checkouts.forgetHelper', { workspace: 'api-dev' }),
        ],
        confirmText: t('projects.checkouts.forgetConfirm', {
          workspace: 'api-dev',
        }),
      },
    ]);
  });
});
