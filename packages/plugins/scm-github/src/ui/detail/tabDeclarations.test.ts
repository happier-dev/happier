import { describe, expect, it } from 'vitest';

import { GITHUB_ADDITIONAL_UI_TRANSLATIONS } from '../additionalTranslations.js';

import {
  GITHUB_DEFAULT_DETAIL_TAB_V1,
  GITHUB_DETAIL_TABS_V1,
  githubDetailTabDeclaration,
  githubResolveSelectedTab,
  githubVisibleDetailTabs,
} from './tabDeclarations.js';

describe('GitHub detail tab declarations', () => {
  it('states a lifetime and a scroll owner on every tab', () => {
    // The shared tab primitive treats an omitted retention as `discard`, so a
    // panel that says nothing acquires a lifetime by accident.
    for (const tab of GITHUB_DETAIL_TABS_V1) {
      expect(['retain', 'discard']).toContain(tab.retention);
      expect(['scrollArea', 'list']).toContain(tab.scrollOwner);
      expect(tab.retainedState.length).toBeGreaterThan(0);
      expect(tab.kinds.length).toBeGreaterThan(0);
    }
  });

  it('shows a pull request its files, checks and feedback, and an issue none of them', () => {
    expect(githubVisibleDetailTabs('pull-request').map((tab) => tab.id))
      .toEqual(['overview', 'timeline', 'files', 'checks', 'feedback']);
    // An issue changes no files and runs no checks. An empty Files list would
    // claim it changes nothing, so the tab is absent rather than empty.
    expect(githubVisibleDetailTabs('issue').map((tab) => tab.id))
      .toEqual(['overview', 'timeline', 'comments', 'work-sessions']);
  });

  it('gives a pull request one conversation tab, and it is Feedback', () => {
    // A pull request whose comments sat in their own tab beside Feedback would
    // read the same GitHub resource twice, once per tab, and split one
    // conversation across two places a reviewer has to check.
    const pullRequest = githubVisibleDetailTabs('pull-request').map((tab) => tab.id);
    expect(pullRequest).toContain('feedback');
    expect(pullRequest).not.toContain('comments');
    // The issue composition keeps `Comments`: an issue has no reviews, checks
    // or merge conflicts to unify, so a Feedback tab there would be a heading
    // over one stream.
    const issue = githubVisibleDetailTabs('issue').map((tab) => tab.id);
    expect(issue).toContain('comments');
    expect(issue).not.toContain('feedback');
  });

  it('names every tab through a catalog key, not a hardcoded English word', () => {
    // A tab title reaches `Tabs.Item` as a plain string, so an untranslated
    // declaration renders English in every locale missing its own entry and
    // nothing fails.
    for (const tab of GITHUB_DETAIL_TABS_V1) {
      expect(tab.titleKey, tab.id).toMatch(/^plugins\.github\.ui\.tab\./u);
      expect(GITHUB_ADDITIONAL_UI_TRANSLATIONS.en[
        tab.titleKey as keyof typeof GITHUB_ADDITIONAL_UI_TRANSLATIONS.en
      ], tab.id).toEqual(tab.title);
    }
  });

  it('opens on a tab that exists for both kinds', () => {
    for (const kindId of ['pull-request', 'issue'] as const) {
      const visible = githubVisibleDetailTabs(kindId);
      expect(visible.some((tab) => tab.id === GITHUB_DEFAULT_DETAIL_TAB_V1)).toBe(true);
      expect(githubResolveSelectedTab(GITHUB_DEFAULT_DETAIL_TAB_V1, visible))
        .toBe(GITHUB_DEFAULT_DETAIL_TAB_V1);
    }
  });

  it('falls back once when a selection names a tab this kind does not have', () => {
    // Switching from a pull request to an issue must not leave the body on a
    // Files panel the issue has no read for.
    expect(githubResolveSelectedTab('files', githubVisibleDetailTabs('issue')))
      .toBe(GITHUB_DEFAULT_DETAIL_TAB_V1);
    expect(githubResolveSelectedTab('timeline', githubVisibleDetailTabs('issue')))
      .toBe('timeline');
  });

  it('gives every plane exactly one owning tab', () => {
    const planes = GITHUB_DETAIL_TABS_V1.map((tab) => tab.readPlane);
    expect(new Set(planes).size).toBe(planes.length);
  });

  it('refuses to describe a tab it never declared', () => {
    expect(() => githubDetailTabDeclaration('overview')).not.toThrow();
    expect(() => githubDetailTabDeclaration(
      'invented' as unknown as (typeof GITHUB_DETAIL_TABS_V1)[number]['id'],
    )).toThrow();
  });
});
