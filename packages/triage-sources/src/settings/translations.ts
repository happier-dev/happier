/**
 * The shared PRs & Issues settings page's own copy, in every locale the first
 * party ships.
 *
 * The page is one page for six sources, so its sentences are one bundle for six
 * sources. Written per source they would be six copies of one wording, and a
 * correction applied to five and forgotten in one would be invisible — the same
 * failure that made this package exist.
 *
 * A plugin UI surface resolves keys against the **mounting plugin's own**
 * declared bundle (`translationsByPluginId`), never a merged catalogue, so each
 * source that contributes this page spreads these messages into its own
 * manifest locale rows. A source that does not spread them still renders the
 * English fallback the model carries; nothing breaks, nothing is translated.
 */
export const TRIAGE_SOURCE_SETTINGS_TRANSLATIONS_V1 = Object.freeze({
  "en": Object.freeze({
    "plugins.triage.sourceSettings.failure.authentication": "The connected account is no longer authorized. Reconnect it in Connected Accounts.",
    "plugins.triage.sourceSettings.failure.permission": "The connected account cannot see this scope. Grant it access at the provider.",
    "plugins.triage.sourceSettings.failure.rateLimit": "The provider is rate limiting this account. Try again shortly.",
    "plugins.triage.sourceSettings.failure.transient": "The provider could not be reached. Try again.",
    "plugins.triage.sourceSettings.failure.unsupportedContract": "The provider returned something this version cannot read.",
    "plugins.triage.sourceSettings.failure.unknown": "The provider could not be read.",
    "plugins.triage.sourceSettings.removeConfirm.title": "Remove {scope} from {product}?",
    "plugins.triage.sourceSettings.removeConfirm.message": "{source} stops contributing {scope} to {product}. Its entries leave the list; the pins and Session links you made stay.",
    "plugins.triage.sourceSettings.removeConfirm.unavailable": "This removal could not be confirmed, so nothing was removed. Try again.",
  }),
  "ru": Object.freeze({
    "plugins.triage.sourceSettings.failure.authentication": "Подключенный аккаунт больше не авторизован. Переподключите его в разделе «Подключенные аккаунты».",
    "plugins.triage.sourceSettings.failure.permission": "Подключенный аккаунт не видит эту область. Предоставьте ему доступ на стороне провайдера.",
    "plugins.triage.sourceSettings.failure.rateLimit": "Провайдер ограничивает частоту запросов этого аккаунта. Повторите попытку чуть позже.",
    "plugins.triage.sourceSettings.failure.transient": "Не удалось связаться с провайдером. Повторите попытку.",
    "plugins.triage.sourceSettings.failure.unsupportedContract": "Провайдер вернул ответ, который эта версия не может прочитать.",
    "plugins.triage.sourceSettings.failure.unknown": "Не удалось прочитать данные провайдера.",
    "plugins.triage.sourceSettings.removeConfirm.title": "Удалить {scope} из «{product}»?",
    "plugins.triage.sourceSettings.removeConfirm.message": "{source} перестанет передавать {scope} в «{product}». Его записи исчезнут из списка; закрепления и ссылки на сессии, которые вы создали, останутся.",
    "plugins.triage.sourceSettings.removeConfirm.unavailable": "Это удаление не удалось подтвердить, поэтому ничего не было удалено. Повторите попытку.",
  }),
  "pl": Object.freeze({
    "plugins.triage.sourceSettings.failure.authentication": "Połączone konto nie jest już autoryzowane. Połącz je ponownie w sekcji Połączone konta.",
    "plugins.triage.sourceSettings.failure.permission": "Połączone konto nie widzi tego zakresu. Przyznaj mu dostęp u dostawcy.",
    "plugins.triage.sourceSettings.failure.rateLimit": "Dostawca ogranicza liczbę żądań tego konta. Spróbuj ponownie za chwilę.",
    "plugins.triage.sourceSettings.failure.transient": "Nie udało się połączyć z dostawcą. Spróbuj ponownie.",
    "plugins.triage.sourceSettings.failure.unsupportedContract": "Dostawca zwrócił odpowiedź, której ta wersja nie potrafi odczytać.",
    "plugins.triage.sourceSettings.failure.unknown": "Nie udało się odczytać danych dostawcy.",
    "plugins.triage.sourceSettings.removeConfirm.title": "Usunąć {scope} z {product}?",
    "plugins.triage.sourceSettings.removeConfirm.message": "{source} przestanie dostarczać {scope} do {product}. Jego wpisy znikną z listy; przypięcia i linki do sesji, które utworzono, pozostaną.",
    "plugins.triage.sourceSettings.removeConfirm.unavailable": "Nie udało się potwierdzić tego usunięcia, więc nic nie zostało usunięte. Spróbuj ponownie.",
  }),
  "es": Object.freeze({
    "plugins.triage.sourceSettings.failure.authentication": "La cuenta conectada ya no está autorizada. Vuelve a conectarla en Cuentas conectadas.",
    "plugins.triage.sourceSettings.failure.permission": "La cuenta conectada no puede ver este ámbito. Concédele acceso en el proveedor.",
    "plugins.triage.sourceSettings.failure.rateLimit": "El proveedor está limitando las solicitudes de esta cuenta. Vuelve a intentarlo en breve.",
    "plugins.triage.sourceSettings.failure.transient": "No se pudo contactar con el proveedor. Vuelve a intentarlo.",
    "plugins.triage.sourceSettings.failure.unsupportedContract": "El proveedor devolvió algo que esta versión no puede leer.",
    "plugins.triage.sourceSettings.failure.unknown": "No se pudo leer el proveedor.",
    "plugins.triage.sourceSettings.removeConfirm.title": "¿Quitar {scope} de {product}?",
    "plugins.triage.sourceSettings.removeConfirm.message": "{source} dejará de aportar {scope} a {product}. Sus entradas salen de la lista; los elementos fijados y los enlaces de sesión que creaste se mantienen.",
    "plugins.triage.sourceSettings.removeConfirm.unavailable": "No se pudo confirmar esta eliminación, así que no se quitó nada. Vuelve a intentarlo.",
  }),
  "fr": Object.freeze({
    "plugins.triage.sourceSettings.failure.authentication": "Le compte connecté n’est plus autorisé. Reconnectez-le dans Comptes connectés.",
    "plugins.triage.sourceSettings.failure.permission": "Le compte connecté ne voit pas cette portée. Accordez-lui l’accès chez le fournisseur.",
    "plugins.triage.sourceSettings.failure.rateLimit": "Le fournisseur limite le débit de ce compte. Réessayez dans un instant.",
    "plugins.triage.sourceSettings.failure.transient": "Le fournisseur n’a pas pu être joint. Réessayez.",
    "plugins.triage.sourceSettings.failure.unsupportedContract": "Le fournisseur a renvoyé une réponse que cette version ne sait pas lire.",
    "plugins.triage.sourceSettings.failure.unknown": "Le fournisseur n’a pas pu être lu.",
    "plugins.triage.sourceSettings.removeConfirm.title": "Retirer {scope} de {product} ?",
    "plugins.triage.sourceSettings.removeConfirm.message": "{source} cesse de fournir {scope} à {product}. Ses entrées quittent la liste ; les épinglages et les liens de session que vous avez créés restent.",
    "plugins.triage.sourceSettings.removeConfirm.unavailable": "Cette suppression n’a pas pu être confirmée, donc rien n’a été retiré. Réessayez.",
  }),
  "it": Object.freeze({
    "plugins.triage.sourceSettings.failure.authentication": "L’account collegato non è più autorizzato. Ricollegalo in Account collegati.",
    "plugins.triage.sourceSettings.failure.permission": "L’account collegato non vede questo ambito. Concedigli l’accesso presso il provider.",
    "plugins.triage.sourceSettings.failure.rateLimit": "Il provider sta limitando le richieste di questo account. Riprova tra poco.",
    "plugins.triage.sourceSettings.failure.transient": "Non è stato possibile raggiungere il provider. Riprova.",
    "plugins.triage.sourceSettings.failure.unsupportedContract": "Il provider ha restituito qualcosa che questa versione non sa leggere.",
    "plugins.triage.sourceSettings.failure.unknown": "Non è stato possibile leggere il provider.",
    "plugins.triage.sourceSettings.removeConfirm.title": "Rimuovere {scope} da {product}?",
    "plugins.triage.sourceSettings.removeConfirm.message": "{source} smette di fornire {scope} a {product}. Le sue voci escono dall’elenco; gli elementi fissati e i collegamenti alle sessioni che hai creato restano.",
    "plugins.triage.sourceSettings.removeConfirm.unavailable": "Non è stato possibile confermare questa rimozione, quindi non è stato rimosso nulla. Riprova.",
  }),
  "pt": Object.freeze({
    "plugins.triage.sourceSettings.failure.authentication": "A conta conectada já não está autorizada. Reconecte-a em Contas conectadas.",
    "plugins.triage.sourceSettings.failure.permission": "A conta conectada não consegue ver este âmbito. Conceda-lhe acesso no fornecedor.",
    "plugins.triage.sourceSettings.failure.rateLimit": "O fornecedor está a limitar os pedidos desta conta. Tente novamente daqui a pouco.",
    "plugins.triage.sourceSettings.failure.transient": "Não foi possível contactar o fornecedor. Tente novamente.",
    "plugins.triage.sourceSettings.failure.unsupportedContract": "O fornecedor devolveu algo que esta versão não consegue ler.",
    "plugins.triage.sourceSettings.failure.unknown": "Não foi possível ler o fornecedor.",
    "plugins.triage.sourceSettings.removeConfirm.title": "Remover {scope} de {product}?",
    "plugins.triage.sourceSettings.removeConfirm.message": "{source} deixa de contribuir com {scope} para {product}. As suas entradas saem da lista; as fixações e as ligações de sessão que criou permanecem.",
    "plugins.triage.sourceSettings.removeConfirm.unavailable": "Não foi possível confirmar esta remoção, por isso nada foi removido. Tente novamente.",
  }),
  "ca": Object.freeze({
    "plugins.triage.sourceSettings.failure.authentication": "El compte connectat ja no està autoritzat. Torna’l a connectar a Comptes connectats.",
    "plugins.triage.sourceSettings.failure.permission": "El compte connectat no pot veure aquest àmbit. Concedeix-li accés al proveïdor.",
    "plugins.triage.sourceSettings.failure.rateLimit": "El proveïdor està limitant les peticions d’aquest compte. Torna-ho a provar d’aquí a poc.",
    "plugins.triage.sourceSettings.failure.transient": "No s’ha pogut contactar amb el proveïdor. Torna-ho a provar.",
    "plugins.triage.sourceSettings.failure.unsupportedContract": "El proveïdor ha retornat una cosa que aquesta versió no pot llegir.",
    "plugins.triage.sourceSettings.failure.unknown": "No s’ha pogut llegir el proveïdor.",
    "plugins.triage.sourceSettings.removeConfirm.title": "Vols treure {scope} de {product}?",
    "plugins.triage.sourceSettings.removeConfirm.message": "{source} deixarà d’aportar {scope} a {product}. Les seves entrades surten de la llista; els elements fixats i els enllaços de sessió que has creat es mantenen.",
    "plugins.triage.sourceSettings.removeConfirm.unavailable": "No s’ha pogut confirmar aquesta eliminació, així que no s’ha tret res. Torna-ho a provar.",
  }),
  "zh-Hans": Object.freeze({
    "plugins.triage.sourceSettings.failure.authentication": "该已连接账户不再获得授权。请在“已连接账户”中重新连接。",
    "plugins.triage.sourceSettings.failure.permission": "该已连接账户无法访问此范围。请在提供方处为其授予访问权限。",
    "plugins.triage.sourceSettings.failure.rateLimit": "提供方正在限制此账户的请求频率。请稍后重试。",
    "plugins.triage.sourceSettings.failure.transient": "无法连接到提供方。请重试。",
    "plugins.triage.sourceSettings.failure.unsupportedContract": "提供方返回了此版本无法读取的内容。",
    "plugins.triage.sourceSettings.failure.unknown": "无法读取该提供方。",
    "plugins.triage.sourceSettings.removeConfirm.title": "要从「{product}」中移除 {scope} 吗？",
    "plugins.triage.sourceSettings.removeConfirm.message": "{source} 将不再向「{product}」提供 {scope}。其条目会从列表中消失；你创建的置顶和会话链接会保留。",
    "plugins.triage.sourceSettings.removeConfirm.unavailable": "无法确认此次移除，因此未移除任何内容。请重试。",
  }),
  "zh-Hant": Object.freeze({
    "plugins.triage.sourceSettings.failure.authentication": "此已連結帳戶不再獲得授權。請在「已連結帳戶」中重新連結。",
    "plugins.triage.sourceSettings.failure.permission": "此已連結帳戶無法存取此範圍。請在提供方為其授予存取權。",
    "plugins.triage.sourceSettings.failure.rateLimit": "提供方正在限制此帳戶的請求頻率。請稍後再試。",
    "plugins.triage.sourceSettings.failure.transient": "無法連線至提供方。請再試一次。",
    "plugins.triage.sourceSettings.failure.unsupportedContract": "提供方回傳了此版本無法讀取的內容。",
    "plugins.triage.sourceSettings.failure.unknown": "無法讀取該提供方。",
    "plugins.triage.sourceSettings.removeConfirm.title": "要從「{product}」中移除 {scope} 嗎？",
    "plugins.triage.sourceSettings.removeConfirm.message": "{source} 將不再向「{product}」提供 {scope}。其項目會從清單中消失；你建立的釘選和工作階段連結會保留。",
    "plugins.triage.sourceSettings.removeConfirm.unavailable": "無法確認這次移除，因此未移除任何內容。請再試一次。",
  }),
  "ja": Object.freeze({
    "plugins.triage.sourceSettings.failure.authentication": "この接続済みアカウントは認可されていません。「接続済みアカウント」で再接続してください。",
    "plugins.triage.sourceSettings.failure.permission": "この接続済みアカウントはこのスコープを参照できません。プロバイダー側でアクセスを許可してください。",
    "plugins.triage.sourceSettings.failure.rateLimit": "プロバイダーがこのアカウントのレートを制限しています。しばらくしてからもう一度お試しください。",
    "plugins.triage.sourceSettings.failure.transient": "プロバイダーに接続できませんでした。もう一度お試しください。",
    "plugins.triage.sourceSettings.failure.unsupportedContract": "プロバイダーが、このバージョンでは読み取れない応答を返しました。",
    "plugins.triage.sourceSettings.failure.unknown": "プロバイダーを読み取れませんでした。",
    "plugins.triage.sourceSettings.removeConfirm.title": "{scope} を「{product}」から削除しますか？",
    "plugins.triage.sourceSettings.removeConfirm.message": "{source} は {scope} を「{product}」に提供しなくなります。その項目は一覧から消えますが、作成したピン留めとセッションリンクは残ります。",
    "plugins.triage.sourceSettings.removeConfirm.unavailable": "この削除を確認できなかったため、何も削除されていません。もう一度お試しください。",
  }),
});
