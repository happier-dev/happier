import type { SupportedLanguage } from '../_all';

export type Copy = Readonly<{ accountDescription: string; projectDescription: string; useAccount: string; useBuiltin: string;
    sectionDeploys: string; resetBuiltin: string; resetAccount: string;
    retention: string; clearToInherit: string; projectTitle: string; alertChannels: string; accountLink: string;
    triggersTitle: string; triggersDescription: string; askedAtSetup: string }>;
export const deploymentDefaultsTranslations = {
    en: {
        accountDescription: 'Defaults for new environments in your Account-owned projects. Team projects use their shared project defaults.',
        projectDescription: 'Used when you create an environment. Existing environments keep their own settings.',
        useAccount: 'Use Account default', useBuiltin: 'Use Happier’s default', sectionDeploys: 'Deploys', resetBuiltin: 'Reset to Happier’s defaults', resetAccount: 'Reset to your Account defaults', retention: 'Releases kept for rollback',
        clearToInherit: 'Clear to use the inherited default', projectTitle: 'Deployment settings', alertChannels: 'Notification channels', accountLink: 'Your Account deployment defaults',
        triggersTitle: "Triggers", triggersDescription: "Each environment runs its own triggers. Open one to see or add them.",
        askedAtSetup: 'Chosen when you set up each environment',
    },
} satisfies Pick<Record<SupportedLanguage, Copy>, 'en'>;
