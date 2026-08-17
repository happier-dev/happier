type VoiceDiagnosticsConsentCopy = Readonly<{
  consentTitle: string;
  consentBody: string;
  consentAction: string;
}>;

function defineVoiceDiagnosticsConsentTranslation(diagnostics: VoiceDiagnosticsConsentCopy) {
  return { diagnostics };
}

export const voiceDiagnosticsConsentTranslations = {
  ru: defineVoiceDiagnosticsConsentTranslation({
    consentTitle: 'Записывать речь на этом устройстве?',
    consentBody: 'Аудио речи может содержать личные разговоры и фоновые звуки. Файлы остаются на устройстве, защищены закрытыми разрешениями, автоматически удаляются и никогда не синхронизируются и не прикрепляются к аналитике или отчётам о сбоях.',
    consentAction: 'Включить запись',
  }),
  pl: defineVoiceDiagnosticsConsentTranslation({
    consentTitle: 'Nagrywać mowę na tym urządzeniu?',
    consentBody: 'Nagrania mowy mogą zawierać prywatne rozmowy i dźwięki tła. Pliki pozostają na urządzeniu, mają prywatne uprawnienia, wygasają automatycznie i nigdy nie są synchronizowane ani dołączane do analityki lub raportów o awariach.',
    consentAction: 'Włącz nagrywanie',
  }),
  es: defineVoiceDiagnosticsConsentTranslation({
    consentTitle: '¿Grabar audio de voz en este dispositivo?',
    consentBody: 'El audio de voz puede contener conversaciones privadas y sonido de fondo. Los archivos permanecen en el dispositivo, usan permisos privados, caducan automáticamente y nunca se sincronizan ni se adjuntan a análisis o informes de fallos.',
    consentAction: 'Activar grabación',
  }),
  fr: defineVoiceDiagnosticsConsentTranslation({
    consentTitle: 'Enregistrer la parole sur cet appareil ?',
    consentBody: 'L’audio peut contenir des conversations privées et des bruits de fond. Les fichiers restent sur l’appareil, utilisent des autorisations privées, expirent automatiquement et ne sont jamais synchronisés ni joints aux analyses ou rapports de plantage.',
    consentAction: 'Activer l’enregistrement',
  }),
  it: defineVoiceDiagnosticsConsentTranslation({
    consentTitle: 'Registrare l’audio vocale su questo dispositivo?',
    consentBody: 'L’audio vocale può contenere conversazioni private e suoni di sottofondo. I file restano sul dispositivo, usano autorizzazioni private, scadono automaticamente e non vengono mai sincronizzati né allegati ad analisi o segnalazioni di arresti anomali.',
    consentAction: 'Attiva registrazione',
  }),
  pt: defineVoiceDiagnosticsConsentTranslation({
    consentTitle: 'Gravar áudio de voz neste dispositivo?',
    consentBody: 'O áudio de voz pode conter conversas privadas e sons de fundo. Os ficheiros permanecem no dispositivo, usam permissões privadas, expiram automaticamente e nunca são sincronizados nem anexados a análises ou relatórios de falhas.',
    consentAction: 'Ativar gravação',
  }),
  ca: defineVoiceDiagnosticsConsentTranslation({
    consentTitle: 'Vols enregistrar àudio de veu en aquest dispositiu?',
    consentBody: 'L’àudio de veu pot contenir converses privades i sons de fons. Els fitxers es mantenen al dispositiu, utilitzen permisos privats, caduquen automàticament i mai se sincronitzen ni s’adjunten a analítiques o informes d’errors.',
    consentAction: 'Activa l’enregistrament',
  }),
  'zh-Hans': defineVoiceDiagnosticsConsentTranslation({
    consentTitle: '在此设备上录制语音？',
    consentBody: '语音音频可能包含私人对话和背景声音。文件仅保存在本设备，使用私有权限并自动过期，绝不会同步，也不会附加到分析数据或崩溃报告中。',
    consentAction: '启用录制',
  }),
  'zh-Hant': defineVoiceDiagnosticsConsentTranslation({
    consentTitle: '在此裝置上錄製語音？',
    consentBody: '語音音訊可能包含私人對話和背景聲音。檔案只保留在此裝置，使用私密權限並自動到期，絕不會同步，也不會附加到分析資料或當機報告。',
    consentAction: '啟用錄製',
  }),
  ja: defineVoiceDiagnosticsConsentTranslation({
    consentTitle: 'このデバイスで音声を録音しますか？',
    consentBody: '音声には個人的な会話や周囲の音が含まれる場合があります。ファイルはデバイス内にのみ保存され、非公開の権限で保護され、自動的に期限切れになります。同期されたり、分析やクラッシュレポートに添付されたりすることはありません。',
    consentAction: '録音を有効にする',
  }),
} as const;
