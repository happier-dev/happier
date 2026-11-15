import { PUBLIC_PROFILE_PAGE_COPY_EN, PUBLIC_PROFILE_FIELD_COPY_EN } from '@happier-dev/protocol/account/publicProfilePresentationCopy';

/**
 * Copy for the Account handle (one username shared with Friends and the public page) and the
 * public profile settings page. English is the shape every locale block
 * (`features/publicIdentity.<locale>.ts`) must match.
 */
export const publicIdentityEn = {
  publicIdentity: {
    blocks: { sky: 'Sky of days', crew: 'Crew', planet: 'Your planet', orbit: 'Orbit', shipped: 'Shipped' , totals: "Totals", parallel: "Peak parallel", hours: "When agents work", tide: "Week tide" },
    page: PUBLIC_PROFILE_PAGE_COPY_EN,
    publicData: {
      consent: {
        hiding: ({ item }: { item: string }) => `Hiding ${item}…`,
        sharing: ({ item }: { item: string }) => `Sharing ${item}…`,
        hidden: ({ item }: { item: string }) => `${item} is hidden on your public page.`,
        shared: ({ item }: { item: string }) => `${item} is shared on your public page.`,
        failedHide: ({ item }: { item: string }) => `Couldn’t hide ${item}. Your public page is unchanged.`,
        failedShare: ({ item }: { item: string }) => `Couldn’t share ${item}. Your public page is unchanged.`,
        uncertain: ({ item }: { item: string }) => `Not sure the change to ${item} was saved. Check your page before trying again.`,
        undo: 'Undo',
        retry: 'Try again',
        check: 'Check',
      },
      title: 'Public data',
      description: 'What leaves your devices. Every block, badge and card uses only these items.',
      footer: 'Removing a block doesn’t unshare its data; turn the item off here.',
      blocks: ({ count }: { count: number }) => (count === 1 ? 'In 1 block' : `In ${count} blocks`),
      heading: 'At the top of your page',
      notPlaced: 'Not on the page · in badges and JSON',
      placedPrivate: 'Placed, only you see it',
      notShared: 'Not shared',
      needsPeak: 'Needs Peak parallel: your highest week is your peak.',
      sections: { about: 'About you', numbers: 'Numbers', patterns: 'Patterns', detail: 'Finer detail', links: 'Links and estimates' },
      fields: PUBLIC_PROFILE_FIELD_COPY_EN,
      details: {
        calendar: 'Each day as a level, never an amount. The calendar still shows which days you were active.',
        punch: 'When in the week you usually work, as levels.',
        weeklyAgentMix: 'With Tokens public, this lets visitors estimate each week’s amount per agent.',
        sessionDurations: 'How long each finished agent turn took, without names, times or links.',
        machineKinds: 'Agent time by kind of machine, never which machines.',
        dayNightActivity: 'Your share of activity inside your Night shift hours.',
        projects: 'Links to public repositories you choose. Nothing about their usage.',
        footprint: 'Says that no estimate is available yet.',
      },
    },
    details: {
      button: "Details",
      aboutTitle: "About you",
      notSharedMany: ({ items }: { items: string }) => `${items} are off in Public data, so visitors don’t see them.`,
      notShared: ({ item }: { item: string }) => `${item} is off in Public data, so visitors don’t see it.`,
      bioPlaceholder: "A line about you and what you build",
      link: ({ position }: { position: number }) => `Link ${position}`,
      removeLink: ({ position }: { position: number }) => `Remove link ${position}`,
      addLink: "Add link",
      linkInvalid: "Use a full https:// address.",
      photoAccount: "Your photo",
      photoPlanet: "Planet",
      photoAccountUnavailable: "Your account has no photo yet.",
      removeRepository: ({ name }: { name: string }) => `Remove ${name}`,
      addRepository: "Add repository",
      repositoryPlaceholder: "owner/repository or its address",
      repositoryPrivate: "This repository isn’t public, so it can’t be on your page.",
      add: "Add",
      pageTitle: "Your page",
      periodDescription: "Every number, the calendar, badges and card cover the same days.",
      period30: "30 days",
      period90: "90 days",
      periodYear: "1 year",
      theme: "Theme for visitors",
      themeDescription: "Auto follows each visitor’s device.",
      themeAuto: "Auto",
      themeLight: "Light",
      themeDark: "Dark",
      themePicture: "Choose your picture again in Look to change its theme.",
      footer: "Nothing here is public until you publish or apply.",
    },
    editor: {
      presetNightOwl: "Night owl",
      layouts: "Layouts",
      newLayoutBody: "Starts from the blocks on your page now. Nothing is public until you apply it.",
      hiddenBlock: ({ item }: { item: string }) => `${item} isn’t in your public data, so visitors don’t see this block.`,
      hiddenBlockNoItem: "Visitors don’t see this block.",
      shareItem: ({ item }: { item: string }) => `Share ${item.charAt(0).toLocaleLowerCase()}${item.slice(1)}`,
      hideItem: ({ item }: { item: string }) => `Hide ${item.charAt(0).toLocaleLowerCase()}${item.slice(1)} from visitors`,
      undoTitle: "Undo your last Apply",
      undone: "Your public page is back as it was.",
      startFrom: 'Start from',
      presetMinimal: 'Minimal',
      presetDataRich: 'Data-rich',
      presetStory: 'Story',
      blocksTitle: 'Your blocks',
      addBlock: 'Add a block',
      addBlockTitle: 'Add to your public page',
      copyHint: "Uses your profile’s shared data and period. Private filters, costs and detailed timelines stay private. Review Apply to publish this draft.",
      title: 'Your public page',
      customizing: 'Customizing your profile',
      hintNew: 'Only you can see this until you publish.',
      hintChanges: ({ count }: { count: number }) => (count === 1 ? '1 change, not on your public page yet.' : `${count} changes, not on your public page yet.`),
      privateProjectsOmitted: ({ count }: { count: number }) => `${count} selected projects left out as private.`,
      hintNone: 'Public data decides what visitors see.',
      edit: 'Edit',
      preview: 'Preview',
      mode: 'View',
      look: 'Look',
      publicData: 'Public data',
      publish: 'Publish…',
      apply: 'Apply…',
      statusDraft: 'Not published',
      statusPublished: 'Published',
      statusPaused: 'Paused',
      onlyYou: 'Only you',
      preparing: 'Preparing your page…',
      published: 'Your page is public.',
      applied: 'Your changes are on your public page.',
    },
    review: {
      titlePublish: 'Publish your page',
      titleApply: 'Apply your changes',
      public: 'Public',
      none: 'Nothing but your name and handle.',
      plaintext: 'Published numbers are stored readable by this service, even though your account is end-to-end encrypted.',
      picture: 'Your picture is uploaded as it looks here, and anyone can see it. Make sure you may share it and that it shows nothing private.',
      daily: 'While one of your devices runs Happier, your page refreshes daily from the same items.',
      noindex: 'Search engines won’t list it; people reach it through its link.',
      confirmPublish: 'Publish',
      confirmApply: 'Apply',
      cancel: 'Cancel',
      where: ({ url, period }: { url: string; period: string }) => `Anyone with the link can see it at ${url}. It covers ${period}.`,
      hidden: 'Hidden',
      viewData: 'View public data',
      viewDataDetail: 'All public data and appearance. For a new picture, the pixels are shown above and its public reference is assigned when saved.',
    },
    handle: {
      available: ({ username }: { username: string }) =>
        `@${username} is available`,
      taken: ({ username }: { username: string }) => `@${username} is taken`,
      reserved: ({ username }: { username: string }) =>
        `@${username} is reserved on this service`,
      invalid: 'This service doesn’t allow that username.',
      suggestions: 'Available instead',
      checkFailed:
        'Couldn’t check this username. Your choice is kept; try again.',
      renameConsequence: ({ username }: { username: string }) =>
        `Friends find you by the new name, and links or badges that use @${username} stop working.`,
      releaseTitle: 'Release username',
      releaseDetail: ({ username }: { username: string }) =>
        `Friends stop finding you as @${username}. Anyone can claim @${username} right away, and links that use it may then lead to whoever takes it.`,
      releaseAction: 'Release',
      releaseFailed: 'Couldn’t release your username. Nothing changed.',
    },
    profile: {
      title: 'Public profile',
      entrySubtitle: 'A page that shows what your agents built',
      searchKeywords: 'public profile, public page, badge, README, share, handle, username, publish',
      purposeIntro:
        'A page that shows what your agents built, at a link you choose.',
      purposePublished: ({ url }: { url: string }) =>
        `How others see your agent usage at ${url}.`,
      openPage: 'Open page',
      invitationTitle: 'Show what your agents built',
      invitationBody:
        'Totals, your activity calendar and your agents, on a page you can link from your README. Nothing is public until you publish, and you choose every field.',
      usernameFirst: 'Your page lives at your username. Choose one to begin.',
      chooseUsername: 'Choose a username',
      previewMyProfile: 'Preview my profile',
      editOnPage: 'Edit on your page',
      yourPage: 'Your page',
      link: 'Link',
      status: 'Status',
      statusPublished: ({ synced }: { synced: string }) =>
        `Published · synced ${synced}`,
      statusPaused: 'Paused · visitors see a paused page',
      syncNow: 'Sync now',
      handle: 'Handle',
      handleDetail: ({ username }: { username: string }) => `@${username}`,
      handleDetailWithFriends: ({ username }: { username: string }) =>
        `@${username} · also your username for Friends`,
      change: 'Change',
      whatsPublic: 'What’s public',
      whatsPublicDescription:
        'You choose each item on the page itself. Items you share also appear in badges and the public JSON.',
      period: 'Period',
      periodDetail: ({ range }: { range: string }) =>
        `${range}. Every number, the calendar, badges and card cover the same days.`,
      itemsPublic: ({ shown, total }: { shown: number; total: number }) =>
        `${shown} of ${total} items public`,
      teamUsage: 'Team usage',
      teamUsageDetail:
        'Never included. Usage through a Happier Team or a company subscription stays off your profile.',
      excluded: 'Excluded',
      searchEngines: 'Search engines',
      indexTitle: 'Let search engines index your page',
      indexOff: 'Off: people reach it only through its link',
      indexOn: 'On: search engines may list your page',
      pauseOrRemove: 'Pause or remove',
      pauseTitle: 'Pause profile',
      pauseDetail:
        'Keeps your link and handle; visitors see a paused page until you resume',
      pause: 'Pause',
      resumeTitle: 'Resume profile',
      resumeDetail:
        'Recomputes your page from the same items and shows it again',
      resume: 'Resume',
      unpublishTitle: 'Unpublish',
      unpublishDetail:
        'Deletes the public record. Your page, badges and preview image stop working the next time they’re requested; images already posted elsewhere stay where they are.',
      resumeConfirm: 'Your page comes back with fresh numbers. What it shares stays the same.',
      unpublishConfirm: 'Your page, its JSON and badges stop working. Your handle stays yours.',
      unpublishAction: 'Unpublish…',
      restrictedTitle: 'Your page was removed',
      restrictedBody: ({ reason }: { reason: string }) =>
        `The operator of this service removed your page: “${reason}”. Contact them to ask about it. Your usage and username are unchanged.`,
      unavailableTitle: 'Public profiles aren’t available here',
      unavailableBodyThisHome: 'This Home doesn’t offer public profiles. Your usage stays private.',
      unavailableBody: ({ home }: { home: string }) =>
        `${home} doesn’t offer public profiles. Your usage stays private.`,
      loadFailedTitle: 'Couldn’t load your public profile',
      loadFailedBody: 'Nothing changed. Try again in a moment.',
      retry: 'Try again',
      actionFailed: 'That didn’t go through. Nothing changed.',
      actionUncertain: 'The service didn’t answer. Your page below is what it shows now.',
      reasons: {
        feature_disabled: 'Public profiles are turned off on this service.',
        username_required: 'Choose a username first.',
        report_contact_unconfigured:
          'This service hasn’t set a contact for reports yet, so pages can’t be published. Ask its operator.',
        public_ingress_unconfigured:
          'This service hasn’t set a public address yet, so pages can’t be published. Ask its operator.',
        not_published: 'Your page isn’t published.',
        restricted: 'This service’s operator removed your page.',
        query_mismatch:
          'Your usage period changed. Open your page and apply it again.',
        invalid_stored_content:
          'Your public page couldn’t be read. Publish it again.',
        asset_unavailable:
          'Your page’s picture isn’t on this device. Choose it again.',
        usage_unavailable: 'Your usage can’t be read on this device right now.',
        no_eligible_personal_usage: 'No usage to share yet. Public profiles leave out Team usage and usage on company subscriptions.',
        source_time_unavailable: 'The observation time for your usage is unavailable. Try again when the source can be read.',
        period_unavailable: 'Your usage period is unavailable. Choose a period and try again.',
        invalid_snapshot: 'Your usage couldn’t be prepared for sharing. Try again.',
        usage_query_result_invalid:
          'Your usage came back incomplete. Try again.',
        project_visibility_unavailable:
          'Couldn’t confirm a project is public. It stays off your page.',
        preparation_unavailable:
          'This device can’t prepare your page right now.',
      },
    },
    look: {
      title: 'Look',
      description:
        'The same choices as your Home. Applying copies them to your public page.',
      creditOnPage: ({ credit }: { credit: string }) =>
        `Credit shown on your page: ${credit}.`,
      devicePictureDisclosure:
        'This picture is on this device only. Applying uploads one copy to your public page; make sure you may share it, and that it shows nothing private.',
      missingTitle: ({ name }: { name: string }) =>
        `“${name}” isn’t on this device`,
      missingBody:
        'Pick it again on the device you added it from, or choose another picture. Your public page keeps its current header.',
      choosePicture: 'Choose a picture',
    },
    share: {
      outputLabel: 'What to share',
      output_image: 'Image',
      output_profile_link: 'Profile link',
      output_badge: 'Badge',
      output_card: 'Card',
      unpublished_profile_link: 'Publish your profile to get a link',
      unpublished_badge: 'Publish your profile to get a badge',
      unpublished_card: 'Publish your profile to get a card',
      unpublishedBody: 'Your public page shows totals, your calendar and your agents. You choose every field first.',
      previewProfile: 'Preview my profile',
      imagesWithoutProfile: 'Images can be shared without a profile: they’re made on this device.',
      imageFrom: 'Image from',
      imageFrom_usage: 'Your usage',
      imageFrom_public_profile: 'Public profile',
      unpublished_image: 'Publish your profile to make an image from it',
      imageFromProfileNote: 'Shows only what your public page shows. Made on this device.',
      readFailed: 'Couldn’t read your public page',
      readFailedBody: 'Nothing changed. Try again in a moment.',
      serviceUnavailable: 'Your public page can’t be read right now',
      metricHidden: ({ metric }: { metric: string }) =>
        `${metric} isn’t public on your page`,
      metricHiddenBody: 'A badge shows only what you made public. Share it from your profile, or choose another number.',
      shows: 'Shows',
      metric_tokens: 'Tokens',
      metric_agentTime: 'Agent time',
      metric_mergedPrs: 'Merged PRs',
      metric_streak: 'Current streak',
      metric_peakParallel: 'Peak parallel agents',
      theme: 'Theme',
      theme_auto: 'Auto',
      theme_light: 'Light',
      theme_dark: 'Dark',
      copyAs: 'Copy as',
      syntax_markdown: 'Markdown',
      syntax_html: 'HTML',
      syntax_picture: 'Picture',
      syntax_url: 'URL',
      copySnippet: 'Copy snippet',
      copyLink: 'Copy link',
      copied: 'Copied',
      copyFailed: 'Couldn’t copy. Select the text and copy it yourself.',
      liveNote_badge: 'Live: it follows your page, and stops working if you unpublish.',
      liveNote_card: 'Live: it follows your page, and stops working if you unpublish. Copies saved as images stay as they are.',
      previewImage: 'Preview image',
      previewImageDetail: 'Your page’s hero, updated when your profile syncs.',
      unfurlTitleNamed: ({ name, handle, service }: { name: string; handle: string; service: string }) =>
        `${name} (@${handle}) on ${service}`,
      unfurlTitle: ({ handle, service }: { handle: string; service: string }) =>
        `@${handle} on ${service}`,
    },
  },
};

type TranslationShape<T> = T extends (...args: infer Args) => infer Return
  ? (...args: Args) => Return
  : T extends string
    ? string
    : { readonly [K in keyof T]: TranslationShape<T[K]> };

export type PublicIdentityTranslations = TranslationShape<
  typeof publicIdentityEn
>;
