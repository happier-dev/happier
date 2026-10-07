

export type Copy = typeof en;



export const en = {
    recoverAutomationTemplates: 'Recover older triggers',
    recoverAutomationTemplatesDescription: 'Use the keys on this device to recover older triggers. Keys stay here while encrypted sessions or locked triggers still need them.',
    recoverAutomationTemplatesAction: 'Recover',
    recoverAutomationTemplatesComplete: 'Older triggers recovered. The old encryption key stays on this device until you choose to forget it.',
    recoverAutomationTemplatesRetained: 'Recovery checked. Some triggers remain encrypted, locked, or changed. The old encryption key stays on this device.',
    forgetEncryptionKey: 'Forget the old encryption key',
    forgetEncryptionKeyDescription: 'Older encrypted sessions on this device become locked.',
    forgetEncryptionKeyAction: 'Forget',
    forgetEncryptionKeyConfirm: 'Forget the old encryption key?',
    forgetEncryptionKeyWarning: ({ items }: { items: string }) => `Older encrypted sessions on this device become locked. The following encrypted history may become inaccessible:\n\n${items}\n\nThis list reflects the current history. Encrypted sessions created on another device after this check also become locked. Restore the old key to unlock them. Nothing is deleted from your account.`,
    forgetEncryptionKeySession: ({ name, id }: { name: string; id: string }) => `Session: ${name} (${id})`,
    forgetEncryptionKeyTrigger: ({ id }: { id: string }) => `Trigger: ${id}`,
    forgetEncryptionKeyRun: ({ id }: { id: string }) => `Run history: ${id}`,
    forgetEncryptionKeyEmpty: 'No encrypted history was found.',
    forgetEncryptionKeyComplete: 'The old encryption key was forgotten on this device.',
    forgetEncryptionKeyFailed: 'Could not forget the key. Reconnect and try again; encrypted history must be listed before the key can be forgotten.',
};


export const accountEncryptionRecoveryTranslationsEnglish = { en } as const;