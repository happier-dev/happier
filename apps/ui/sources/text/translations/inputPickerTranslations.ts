/**
 * A typed field's custom picker (lab `dashboards` IN "Custom picker"): the control that opens a
 * plugin's own picker beneath an Action, Workflow or widget field, and what the field says when
 * the picker cannot give it a value. Cancelling says nothing; the field keeps what it had.
 */
type InputPickerTranslation = Readonly<{
    /** The control beneath the field. */
    browse: string;
    /** Its accessible name, naming the field it chooses for. */
    browseField: (params: Readonly<{ field: string }>) => string;
    /** The plugin that provides this choice was removed or turned off. */
    unavailable: string;
    /** The plugin was updated while its picker was open. */
    retired: string;
    /** The picker answered with something this field cannot hold. */
    invalid: string;
    /** The picker could not open or failed. */
    failed: string;
}>;

export const inputPickerTranslations = {
    en: {
        browse: 'Browse…',
        browseField: ({ field }) => `Browse for ${field}`,
        unavailable: 'The plugin that provides this choice isn’t available. Your current value is kept.',
        retired: 'The plugin was updated while you were choosing. Try again.',
        invalid: 'That choice can’t be used here. Your current value is kept.',
        failed: 'The picker couldn’t open. Try again.',
    },
    ca: {
        browse: 'Explora…',
        browseField: ({ field }) => `Explora per a ${field}`,
        unavailable: 'El connector que ofereix aquesta opció no està disponible. Es conserva el valor actual.',
        retired: 'El connector s’ha actualitzat mentre triaves. Torna-ho a provar.',
        invalid: 'Aquesta opció no es pot fer servir aquí. Es conserva el valor actual.',
        failed: 'El selector no s’ha pogut obrir. Torna-ho a provar.',
    },
    de: {
        browse: 'Durchsuchen…',
        browseField: ({ field }) => `${field} durchsuchen`,
        unavailable: 'Das Plugin für diese Auswahl ist nicht verfügbar. Dein aktueller Wert bleibt erhalten.',
        retired: 'Das Plugin wurde während der Auswahl aktualisiert. Versuche es erneut.',
        invalid: 'Diese Auswahl ist hier nicht möglich. Dein aktueller Wert bleibt erhalten.',
        failed: 'Die Auswahl konnte nicht geöffnet werden. Versuche es erneut.',
    },
    es: {
        browse: 'Explorar…',
        browseField: ({ field }) => `Explorar para ${field}`,
        unavailable: 'El plugin que ofrece esta opción no está disponible. Se conserva tu valor actual.',
        retired: 'El plugin se actualizó mientras elegías. Inténtalo de nuevo.',
        invalid: 'Esa opción no se puede usar aquí. Se conserva tu valor actual.',
        failed: 'No se pudo abrir el selector. Inténtalo de nuevo.',
    },
    fr: {
        browse: 'Parcourir…',
        browseField: ({ field }) => `Parcourir pour ${field}`,
        unavailable: 'Le plugin qui fournit ce choix n’est pas disponible. Votre valeur actuelle est conservée.',
        retired: 'Le plugin a été mis à jour pendant votre choix. Réessayez.',
        invalid: 'Ce choix n’est pas utilisable ici. Votre valeur actuelle est conservée.',
        failed: 'Le sélecteur n’a pas pu s’ouvrir. Réessayez.',
    },
    it: {
        browse: 'Sfoglia…',
        browseField: ({ field }) => `Sfoglia per ${field}`,
        unavailable: 'Il plugin che fornisce questa scelta non è disponibile. Il valore attuale resta invariato.',
        retired: 'Il plugin è stato aggiornato mentre sceglievi. Riprova.',
        invalid: 'Questa scelta non può essere usata qui. Il valore attuale resta invariato.',
        failed: 'Impossibile aprire il selettore. Riprova.',
    },
    ja: {
        browse: '参照…',
        browseField: ({ field }) => `${field}を参照`,
        unavailable: 'この選択肢を提供するプラグインを利用できません。現在の値はそのままです。',
        retired: '選択中にプラグインが更新されました。もう一度お試しください。',
        invalid: 'この選択肢はここでは使えません。現在の値はそのままです。',
        failed: 'ピッカーを開けませんでした。もう一度お試しください。',
    },
    pl: {
        browse: 'Przeglądaj…',
        browseField: ({ field }) => `Przeglądaj: ${field}`,
        unavailable: 'Wtyczka, która udostępnia ten wybór, jest niedostępna. Bieżąca wartość zostaje zachowana.',
        retired: 'Wtyczka została zaktualizowana podczas wybierania. Spróbuj ponownie.',
        invalid: 'Tego wyboru nie można tu użyć. Bieżąca wartość zostaje zachowana.',
        failed: 'Nie udało się otworzyć wyboru. Spróbuj ponownie.',
    },
    pt: {
        browse: 'Procurar…',
        browseField: ({ field }) => `Procurar para ${field}`,
        unavailable: 'O plugin que oferece esta opção não está disponível. O valor atual é mantido.',
        retired: 'O plugin foi atualizado enquanto você escolhia. Tente novamente.',
        invalid: 'Essa opção não pode ser usada aqui. O valor atual é mantido.',
        failed: 'Não foi possível abrir o seletor. Tente novamente.',
    },
    ru: {
        browse: 'Обзор…',
        browseField: ({ field }) => `Обзор: ${field}`,
        unavailable: 'Плагин, предоставляющий этот выбор, недоступен. Текущее значение сохранено.',
        retired: 'Плагин обновился, пока вы выбирали. Попробуйте ещё раз.',
        invalid: 'Этот вариант здесь использовать нельзя. Текущее значение сохранено.',
        failed: 'Не удалось открыть выбор. Попробуйте ещё раз.',
    },
    'zh-Hans': {
        browse: '浏览…',
        browseField: ({ field }) => `浏览${field}`,
        unavailable: '提供此选项的插件不可用。当前值保持不变。',
        retired: '选择期间插件已更新。请重试。',
        invalid: '此选项不能在这里使用。当前值保持不变。',
        failed: '无法打开选择器。请重试。',
    },
    'zh-Hant': {
        browse: '瀏覽…',
        browseField: ({ field }) => `瀏覽${field}`,
        unavailable: '提供此選項的外掛程式無法使用。目前的值保持不變。',
        retired: '選擇期間外掛程式已更新。請再試一次。',
        invalid: '此選項無法在這裡使用。目前的值保持不變。',
        failed: '無法開啟選擇器。請再試一次。',
    },
} satisfies Readonly<Record<string, InputPickerTranslation>>;
